#!/usr/bin/env python3
"""Bounded asynchronous worker for temporary curriculum uploads."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import PurePosixPath
from typing import Any

MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_UNITS = 500
MAX_TEXT_PER_UNIT = 200_000
MAX_TABLE_ROWS = 2_000
MAX_TABLE_COLUMNS = 100
MAX_WORKER_JOBS = 3
STALE_CLAIM_MINUTES = 30
EXTRACTION_VERSION = "1.0.0"
BUCKET = "curriculum-temporary"
OBJECT_SIGNATURES = {
    ".docx": "word/document.xml",
    ".xlsx": "xl/workbook.xml",
    ".pptx": "ppt/presentation.xml",
}
OBJECTIVE_PREFIX = re.compile(r"^\s*((?:\d+(?:\.\d+)+|[a-z]\)|\([ivxlcdm]+\)))\s+(.+?)\s*$", re.I)
OBJECTIVE_VERB = re.compile(
    r"\b(describe|state|identify|explain|calculate|compare|deduce|determine|"
    r"construct|interpret|outline|define|recognise|recognize|sketch|draw|"
    r"list|name|give|suggest|predict|analyse|analyze|evaluate|discuss|show)\b",
    re.I,
)
DIAGRAM_HINT = re.compile(r"\b(?:figure|diagram|graph|map|image|not to scale)\b", re.I)
HEADING_STYLES = {"title", "subtitle", "heading 1", "heading 2", "heading 3", "heading 4"}
CONTENT_TYPES = {
    ".pdf": {"application/pdf", "application/octet-stream"},
    ".docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream"},
    ".doc": {"application/msword", "application/octet-stream"},
    ".xlsx": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream"},
    ".xls": {"application/vnd.ms-excel", "application/octet-stream"},
    ".csv": {"text/csv", "application/csv", "application/octet-stream", "text/plain"},
    ".pptx": {"application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/octet-stream"},
    ".txt": {"text/plain", "application/octet-stream"},
}
OLE_SIGNATURE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


class WorkerError(Exception):
    pass


@dataclass
class Unit:
    kind: str
    reference: str
    number: int
    text: str
    tables: list[list[list[str]]] = field(default_factory=list)
    method: str = "text"
    confidence: float | None = None
    needs_review: bool = False
    warnings: list[str] = field(default_factory=list)
    headings: list[dict[str, str]] = field(default_factory=list)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _error_message(error: Exception) -> str:
    return str(error).strip()[:1000] or error.__class__.__name__


def safe_storage_path(value: str, school_id: str, document_id: str) -> str:
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or "\\" in value or len(path.parts) != 3:
        raise WorkerError("The temporary storage path is invalid.")
    if path.parts[0] != school_id or path.parts[1] != document_id:
        raise WorkerError("The temporary storage path is outside this document's school folder.")
    return str(path)


def validate_file_payload(filename: str, content: bytes, content_type: str = "application/octet-stream") -> str:
    extension = PurePosixPath(filename).suffix.casefold()
    if extension not in CONTENT_TYPES:
        raise WorkerError("This curriculum file format is not supported.")
    if content_type.casefold() not in CONTENT_TYPES[extension]:
        raise WorkerError("The uploaded content type does not match the selected file format.")
    if not content or len(content) > MAX_FILE_BYTES:
        raise WorkerError("The curriculum file is empty or exceeds the 50 MB limit.")

    if extension == ".pdf":
        if not content.startswith(b"%PDF-"):
            raise WorkerError("The file does not have a valid PDF signature.")
    elif extension in OBJECT_SIGNATURES:
        if not content.startswith(b"PK"):
            raise WorkerError("The file does not have a valid Office document signature.")
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                members = archive.infolist()
                if len(members) > 2_000 or sum(member.file_size for member in members) > 200 * 1024 * 1024:
                    raise WorkerError("The Office archive exceeds the safe extraction limits.")
                if any(member.file_size > 100 * 1024 * 1024
                       or (member.compress_size > 0 and member.file_size / member.compress_size > 200)
                       for member in members):
                    raise WorkerError("The Office archive contains an unsafe compressed entry.")
                names = {member.filename for member in members}
                if "[Content_Types].xml" not in names or OBJECT_SIGNATURES[extension] not in names:
                    raise WorkerError("The Office file signature does not match its extension.")
                bad_member = archive.testzip()
                if bad_member:
                    raise WorkerError(f"The Office document contains a corrupt entry: {bad_member[:120]}.")
        except zipfile.BadZipFile as error:
            raise WorkerError("The Office document archive is malformed.") from error
    elif extension in {".doc", ".xls"}:
        if not content.startswith(OLE_SIGNATURE):
            raise WorkerError("The legacy Office file does not have a valid compound-document signature.")
    else:
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise WorkerError("CSV and TXT files must contain valid UTF-8 text.") from error
        if "\x00" in text:
            raise WorkerError("The text file contains binary data.")
        if extension == ".csv" and not any(delimiter in text for delimiter in (",", ";", "\t", "|")):
            raise WorkerError("The CSV file does not contain recognizable tabular delimiters.")
    return hashlib.sha256(content).hexdigest()


def _limit_text(value: str, label: str) -> tuple[str, bool]:
    if len(value) <= MAX_TEXT_PER_UNIT:
        return value, False
    return value[:MAX_TEXT_PER_UNIT], True


def _ocr_image(content: bytes) -> tuple[str, float | None]:
    try:
        from PIL import Image
        import pytesseract
        from pytesseract import Output
    except ImportError as error:
        raise WorkerError("OCR dependencies are unavailable on this worker.") from error
    image = Image.open(io.BytesIO(content))
    result = pytesseract.image_to_data(image, output_type=Output.DICT, config="--psm 6")
    words: list[str] = []
    confidences: list[float] = []
    for word, raw_confidence in zip(result.get("text", []), result.get("conf", [])):
        if word.strip():
            words.append(word)
            try:
                confidence = float(raw_confidence)
                if confidence >= 0:
                    confidences.append(confidence)
            except (TypeError, ValueError):
                continue
    text = " ".join(words).strip()
    confidence = round(sum(confidences) / len(confidences), 2) if confidences else None
    if not text:
        raise WorkerError("OCR did not recover readable text from an image.")
    return text, confidence


def _page_is_image_bearing(page: Any) -> bool:
    try:
        if page.get_images(full=True):
            return True
        if page.get_drawings():
            return True
    except (AttributeError, RuntimeError):
        return False
    return False


def _extract_pdf(content: bytes) -> list[Unit]:
    try:
        import fitz
    except ImportError as error:
        raise WorkerError("PyMuPDF is not installed on this worker.") from error
    try:
        document = fitz.open(stream=content, filetype="pdf")
    except Exception as error:
        raise WorkerError(f"The PDF could not be opened: {_error_message(error)}") from error
    if document.page_count < 1 or document.page_count > MAX_UNITS:
        raise WorkerError(f"PDF page count must be between 1 and {MAX_UNITS}.")
    units: list[Unit] = []
    for index, page in enumerate(document):
        if page.rect.width > 2500 or page.rect.height > 2500 or page.rect.width * page.rect.height > 4_000_000:
            raise WorkerError(f"PDF page {index + 1} exceeds the safe page dimensions.")
        warnings: list[str] = []
        text = page.get_text("text", sort=True).strip()
        tables: list[list[list[str]]] = []
        try:
            table_finder = page.find_tables()
            for table in table_finder.tables[:20]:
                rows = table.extract()[:MAX_TABLE_ROWS]
                tables.append([[str(cell or "")[:4000] for cell in row[:MAX_TABLE_COLUMNS]] for row in rows])
        except (AttributeError, RuntimeError, ValueError) as error:
            warnings.append(f"Table extraction needs review: {_error_message(error)}")
        method = "pdf-text"
        confidence: float | None = None
        needs_review = False
        if len(text) < 25 and _page_is_image_bearing(page):
            try:
                image = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).tobytes("png")
                text, confidence = _ocr_image(image)
                method = "ocr"
                needs_review = confidence is None or confidence < 75
                if needs_review:
                    warnings.append("OCR confidence is below 75; verify this page against the uploaded source.")
            except (WorkerError, RuntimeError, OSError) as error:
                warnings.append(f"Page OCR failed: {_error_message(error)}")
                needs_review = True
        if len(text) < 25 and _page_is_image_bearing(page):
            raise WorkerError(f"Page {index + 1} contains visual content that could not be extracted: {'; '.join(warnings)}")
        if not text and not tables and not _page_is_image_bearing(page):
            warnings.append("Page has no extractable text or table content.")
            needs_review = True
        text, truncated = _limit_text(text, f"page {index + 1}")
        if truncated:
            warnings.append("Page text exceeded the per-unit limit and was truncated; the document must be reviewed.")
            needs_review = True
        units.append(Unit(
            kind="page", reference=f"page:{index + 1}", number=index + 1,
            text=text, tables=tables, method=method, confidence=confidence,
            needs_review=needs_review, warnings=warnings,
        ))
    return units


def _extract_docx(content: bytes) -> list[Unit]:
    try:
        from docx import Document
    except ImportError as error:
        raise WorkerError("python-docx is not installed on this worker.") from error
    try:
        document = Document(io.BytesIO(content))
    except Exception as error:
        raise WorkerError(f"The DOCX document could not be opened: {_error_message(error)}") from error
    lines: list[str] = []
    headings: list[dict[str, str]] = []
    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if not text:
            continue
        style = (paragraph.style.name if paragraph.style else "Normal").strip()
        lines.append(text)
        if style.casefold() in HEADING_STYLES:
            headings.append({"level": style, "text": text})
    tables: list[list[list[str]]] = []
    for table in document.tables[:100]:
        tables.append([
            [cell.text.strip()[:4000] for cell in row.cells[:MAX_TABLE_COLUMNS]]
            for row in table.rows[:MAX_TABLE_ROWS]
        ])
    warnings: list[str] = []
    image_text: list[str] = []
    for relationship in document.part.rels.values():
        if relationship.reltype.endswith("/image"):
            try:
                text, confidence = _ocr_image(relationship.target_part.blob)
                image_text.append(text)
                if confidence is not None and confidence < 75:
                    warnings.append("An embedded image has low-confidence OCR.")
            except (WorkerError, OSError) as error:
                warnings.append(f"An embedded image needs review: {_error_message(error)}")
    if image_text:
        lines.extend(f"[Embedded image text] {text}" for text in image_text)
    merged_text, truncated = _limit_text("\n".join(lines), "DOCX")
    if truncated:
        warnings.append("Document text exceeded the per-unit limit and was truncated.")
    if not merged_text.strip() and not tables:
        raise WorkerError("The DOCX document contains no readable paragraphs or tables.")
    return [Unit(
        kind="text", reference="document:1", number=1, text=merged_text,
        tables=tables, method="docx", needs_review=truncated or bool(warnings),
        warnings=warnings, headings=headings,
    )]


def _extract_legacy_doc(content: bytes) -> list[Unit]:
    if not content.startswith(OLE_SIGNATURE):
        raise WorkerError("The DOC file does not have a valid legacy Office signature.")
    try:
        with tempfile.TemporaryDirectory(prefix="campus-curriculum-") as directory:
            source = os.path.join(directory, "source.doc")
            with open(source, "wb") as file:
                file.write(content)
            result = subprocess.run(
                ["antiword", source],
                capture_output=True,
                check=False,
                timeout=60,
            )
    except FileNotFoundError as error:
        raise WorkerError("Legacy DOC extraction requires antiword; install it on the worker.") from error
    except subprocess.TimeoutExpired as error:
        raise WorkerError("Legacy DOC extraction exceeded 60 seconds.") from error
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", errors="replace")[:300]
        raise WorkerError(f"Legacy DOC extraction failed: {message}")
    text = result.stdout.decode("utf-8", errors="replace").strip()
    if not text:
        raise WorkerError("The DOC document contains no extractable text.")
    text, truncated = _limit_text(text, "DOC")
    return [Unit(
        kind="text", reference="document:1", number=1, text=text,
        method="antiword", needs_review=truncated,
        warnings=["Document text exceeded the per-unit limit and was truncated."] if truncated else [],
    )]


def _extract_xlsx(content: bytes) -> list[Unit]:
    try:
        import openpyxl
    except ImportError as error:
        raise WorkerError("openpyxl is not installed on this worker.") from error
    try:
        workbook = openpyxl.load_workbook(io.BytesIO(content), data_only=False, read_only=False)
        cached_workbook = openpyxl.load_workbook(io.BytesIO(content), data_only=True, read_only=False)
    except Exception as error:
        raise WorkerError(f"The XLSX workbook could not be opened: {_error_message(error)}") from error
    if not workbook.worksheets or len(workbook.worksheets) > MAX_UNITS:
        raise WorkerError(f"Worksheet count must be between 1 and {MAX_UNITS}.")
    units: list[Unit] = []
    for sheet in workbook.worksheets:
        cached = cached_workbook[sheet.title]
        rows: list[list[str]] = []
        formulas: list[str] = []
        for row in sheet.iter_rows():
            if len(rows) >= MAX_TABLE_ROWS:
                break
            values: list[str] = []
            for cell in row[:MAX_TABLE_COLUMNS]:
                formula = cell.value if isinstance(cell.value, str) and cell.value.startswith("=") else None
                cached_value = cached[cell.coordinate].value
                value = cached_value if formula and cached_value is not None else cell.value
                values.append("" if value is None else str(value)[:4000])
                if formula:
                    formulas.append(f"{cell.coordinate}: {formula} => {cached_value!s}")
            if any(value for value in values):
                rows.append(values)
        warnings: list[str] = []
        if sheet.sheet_state != "visible":
            warnings.append(f"Worksheet is {sheet.sheet_state}; included for completeness.")
        if formulas and any("None" in value for value in formulas):
            warnings.append("Some formulas have no cached result; their formulas and available values are retained.")
        if sheet.max_row > MAX_TABLE_ROWS or sheet.max_column > MAX_TABLE_COLUMNS:
            warnings.append("Worksheet exceeded the extraction row or column limit.")
        table = rows
        text = "\n".join(
            f"Row {row_index + 1}: " + " | ".join(value for value in row if value)
            for row_index, row in enumerate(rows)
        )
        if formulas:
            text += "\nFormula details:\n" + "\n".join(formulas[:MAX_TABLE_ROWS])
        text, truncated = _limit_text(text, f"worksheet {sheet.title}")
        if truncated:
            warnings.append("Worksheet text exceeded the per-unit limit and was truncated.")
        units.append(Unit(
            kind="worksheet", reference=f"worksheet:{sheet.title}", number=len(units) + 1,
            text=text, tables=[table] if table else [], method="xlsx",
            needs_review=bool(warnings), warnings=warnings,
        ))
    return units


def _extract_xls(content: bytes) -> list[Unit]:
    try:
        import xlrd
    except ImportError as error:
        raise WorkerError("xlrd is not installed on this worker.") from error
    try:
        workbook = xlrd.open_workbook(file_contents=content, on_demand=True)
    except Exception as error:
        raise WorkerError(f"The XLS workbook could not be opened: {_error_message(error)}") from error
    if workbook.nsheets < 1 or workbook.nsheets > MAX_UNITS:
        raise WorkerError(f"Worksheet count must be between 1 and {MAX_UNITS}.")
    units: list[Unit] = []
    for index in range(workbook.nsheets):
        sheet = workbook.sheet_by_index(index)
        rows = [
            [str(sheet.cell_value(row, column))[:4000] for column in range(min(sheet.ncols, MAX_TABLE_COLUMNS))]
            for row in range(min(sheet.nrows, MAX_TABLE_ROWS))
        ]
        text = "\n".join(
            f"Row {row_index + 1}: " + " | ".join(value for value in row if value)
            for row_index, row in enumerate(rows)
        )
        warnings = []
        if sheet.nrows > MAX_TABLE_ROWS or sheet.ncols > MAX_TABLE_COLUMNS:
            warnings.append("Worksheet exceeded the extraction row or column limit.")
        text, truncated = _limit_text(text, f"worksheet {sheet.name}")
        if truncated:
            warnings.append("Worksheet text exceeded the per-unit limit and was truncated.")
        units.append(Unit(
            kind="worksheet", reference=f"worksheet:{sheet.name}", number=index + 1,
            text=text, tables=[rows] if rows else [], method="xls",
            needs_review=bool(warnings), warnings=warnings,
        ))
    return units


def _extract_csv(content: bytes) -> list[Unit]:
    text = content.decode("utf-8-sig")
    sample = text[:8192]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows: list[list[str]] = []
    try:
        for row in csv.reader(io.StringIO(text), dialect):
            if len(rows) >= MAX_TABLE_ROWS:
                break
            rows.append([cell[:4000] for cell in row[:MAX_TABLE_COLUMNS]])
    except csv.Error as error:
        raise WorkerError(f"The CSV file could not be parsed: {_error_message(error)}") from error
    if not rows:
        raise WorkerError("The CSV file contains no rows.")
    warnings = []
    if text.count("\n") + 1 > MAX_TABLE_ROWS:
        warnings.append("CSV exceeded the extraction row limit.")
    unit_text = "\n".join(" | ".join(row) for row in rows)
    unit_text, truncated = _limit_text(unit_text, "CSV")
    if truncated:
        warnings.append("CSV text exceeded the per-unit limit and was truncated.")
    return [Unit(
        kind="worksheet", reference="worksheet:CSV", number=1, text=unit_text,
        tables=[rows], method="csv", needs_review=bool(warnings), warnings=warnings,
    )]


def _extract_pptx(content: bytes) -> list[Unit]:
    try:
        from pptx import Presentation
    except ImportError as error:
        raise WorkerError("python-pptx is not installed on this worker.") from error
    try:
        presentation = Presentation(io.BytesIO(content))
    except Exception as error:
        raise WorkerError(f"The PowerPoint file could not be opened: {_error_message(error)}") from error
    if not presentation.slides or len(presentation.slides) > MAX_UNITS:
        raise WorkerError(f"Slide count must be between 1 and {MAX_UNITS}.")
    units: list[Unit] = []
    for index, slide in enumerate(presentation.slides):
        lines: list[str] = []
        tables: list[list[list[str]]] = []
        headings: list[dict[str, str]] = []
        warnings: list[str] = []
        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False) and shape.text.strip():
                value = shape.text.strip()
                lines.append(value)
                if getattr(shape, "is_placeholder", False) and shape.placeholder_format.idx == 0:
                    headings.append({"level": "slide-title", "text": value})
            if getattr(shape, "has_table", False):
                tables.append([
                    [cell.text.strip()[:4000] for cell in row.cells[:MAX_TABLE_COLUMNS]]
                    for row in shape.table.rows[:MAX_TABLE_ROWS]
                ])
            if getattr(shape, "shape_type", None) == 13:
                try:
                    text, confidence = _ocr_image(shape.image.blob)
                    lines.append(f"[Embedded image text] {text}")
                    if confidence is not None and confidence < 75:
                        warnings.append("An embedded slide image has low-confidence OCR.")
                except (WorkerError, OSError) as error:
                    warnings.append(f"An embedded slide image needs review: {_error_message(error)}")
        try:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                lines.append(f"[Speaker notes] {notes}")
        except (AttributeError, KeyError, ValueError):
            pass
        text, truncated = _limit_text("\n".join(lines), f"slide {index + 1}")
        if truncated:
            warnings.append("Slide text exceeded the per-unit limit and was truncated.")
        if not text and not tables:
            warnings.append("Slide has no extractable text or table content.")
        units.append(Unit(
            kind="slide", reference=f"slide:{index + 1}", number=index + 1,
            text=text, tables=tables, method="pptx", needs_review=bool(warnings),
            warnings=warnings, headings=headings,
        ))
    return units


def extract_document(filename: str, content: bytes) -> list[Unit]:
    extension = PurePosixPath(filename).suffix.casefold()
    if extension == ".pdf":
        units = _extract_pdf(content)
    elif extension == ".docx":
        units = _extract_docx(content)
    elif extension == ".doc":
        units = _extract_legacy_doc(content)
    elif extension == ".xlsx":
        units = _extract_xlsx(content)
    elif extension == ".xls":
        units = _extract_xls(content)
    elif extension == ".csv":
        units = _extract_csv(content)
    elif extension == ".pptx":
        units = _extract_pptx(content)
    elif extension == ".txt":
        text = content.decode("utf-8-sig").strip()
        if not text:
            raise WorkerError("The TXT file contains no text.")
        text, truncated = _limit_text(text, "TXT")
        units = [Unit(
            kind="text", reference="text:1", number=1, text=text,
            method="plain-text", needs_review=truncated,
            warnings=["Text exceeded the per-unit limit and was truncated."] if truncated else [],
        )]
    else:
        raise WorkerError("This curriculum file format is not supported.")
    if not units or len(units) > MAX_UNITS:
        raise WorkerError(f"Document unit count must be between 1 and {MAX_UNITS}.")
    return units


def extract_curriculum_candidates(units: list[Unit]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    topics: list[dict[str, Any]] = []
    objectives: list[dict[str, Any]] = []
    seen_objectives: set[str] = set()
    for unit_index, unit in enumerate(units):
        for heading_index, heading in enumerate(unit.headings):
            text = heading["text"].strip()
            if text:
                topics.append({
                    "unit_reference": unit.reference,
                    "name": text[:500],
                    "section_number": "",
                    "original_text": text[:5000],
                    "sort_order": unit_index * 1000 + heading_index,
                })
        for line_index, line in enumerate(unit.text.splitlines()):
            match = OBJECTIVE_PREFIX.match(line)
            if not match:
                continue
            section_number, body = match.groups()
            body = body.strip()
            if not body or not OBJECTIVE_VERB.search(body):
                continue
            original_text = f"{section_number} {body}".strip()
            identity = " ".join(original_text.casefold().split())
            if identity in seen_objectives:
                continue
            seen_objectives.add(identity)
            lower = original_text.casefold()
            objective_type = "supplement" if "supplement" in lower else "core"
            objectives.append({
                "unit_reference": unit.reference,
                "section_number": section_number,
                "objective_type": objective_type,
                "original_text": original_text[:5000],
                "sort_order": unit_index * 1000 + line_index,
            })
    return topics, objectives


def ready_for_source_deletion(document: dict[str, Any], job: dict[str, Any]) -> bool:
    manifest = job.get("manifest")
    if not isinstance(manifest, dict):
        return False
    return (
        document.get("status") in {"approved", "deletion_failed"}
        and job.get("claimed_from_status", job.get("status")) in {"ready_to_delete", "source_deletion_failed"}
        and manifest.get("total_units") == manifest.get("processed_units")
        and manifest.get("failed_units") == 0
        and bool(document.get("temporary_storage_path"))
    )


class SupabaseWorker:
    def __init__(self) -> None:
        self.base_url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
        self.service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not self.base_url or not self.service_key:
            raise WorkerError("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the worker environment.")

    def _request(
        self,
        method: str,
        route: str,
        payload: Any = None,
        *,
        prefer: str | None = None,
        timeout: int = 60,
    ) -> tuple[Any, dict[str, str]]:
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {
            "apikey": self.service_key,
            "Authorization": f"Bearer {self.service_key}",
            "Accept": "application/json",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        if prefer:
            headers["Prefer"] = prefer
        request = urllib.request.Request(
            f"{self.base_url}{route}",
            data=body,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read(16 * 1024 * 1024)
                value = json.loads(raw) if raw else None
                return value, {key.lower(): value for key, value in response.headers.items()}
        except urllib.error.HTTPError as error:
            message = error.read(4000).decode("utf-8", errors="replace")
            raise WorkerError(f"Supabase returned HTTP {error.code}: {message}") from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise WorkerError(f"Supabase request failed: {_error_message(error)}") from error

    def _rest(self, method: str, table: str, query: str = "", payload: Any = None, prefer: str | None = None) -> Any:
        value, _ = self._request(method, f"/rest/v1/{table}{'?' + query if query else ''}", payload, prefer=prefer)
        return value

    def _storage_path(self, bucket: str, path: str) -> str:
        encoded = "/".join(urllib.parse.quote(part, safe="") for part in path.split("/"))
        return f"/storage/v1/object/{bucket}/{encoded}"

    def _download(self, path: str) -> bytes:
        request = urllib.request.Request(
            f"{self.base_url}{self._storage_path(BUCKET, path)}",
            headers={"apikey": self.service_key, "Authorization": f"Bearer {self.service_key}"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                content = response.read(MAX_FILE_BYTES + 1)
        except urllib.error.HTTPError as error:
            raise WorkerError(f"Temporary source download returned HTTP {error.code}.") from error
        if not content or len(content) > MAX_FILE_BYTES:
            raise WorkerError("The temporary source is empty or exceeds the configured size limit.")
        return content

    def _delete_and_verify(self, path: str) -> None:
        encoded = "/".join(urllib.parse.quote(part, safe="") for part in path.split("/"))
        deletion_error: WorkerError | None = None
        try:
            self._request("DELETE", f"/storage/v1/object/{BUCKET}/{encoded}", timeout=60)
        except WorkerError as error:
            deletion_error = error
        prefix = urllib.parse.quote(str(PurePosixPath(path).parent), safe="/")
        search = urllib.parse.quote(PurePosixPath(path).name, safe="")
        rows, _ = self._request(
            "POST",
            f"/storage/v1/object/list/{BUCKET}",
            {"prefix": prefix, "limit": 100, "search": search},
            timeout=30,
        )
        if not isinstance(rows, list):
            raise WorkerError("Temporary source deletion could not be verified.")
        if any(row.get("name") == PurePosixPath(path).name for row in rows if isinstance(row, dict)):
            if deletion_error:
                raise deletion_error
            raise WorkerError("Temporary source deletion could not be verified.")

    def _claim(self) -> dict[str, Any] | None:
        for status in ("ready_to_delete", "source_deletion_failed", "queued"):
            rows = self._rest(
                "GET",
                "curriculum_processing_jobs",
                f"status=eq.{status}&select=id,school_id,document_id,status,attempt_count,manifest,claimed_at,claimed_from_status&order=created_at.asc&limit=1",
            )
            if not rows:
                continue
            job = rows[0]
            updated = self._rest(
                "PATCH",
                "curriculum_processing_jobs",
                f"id=eq.{job['id']}&status=eq.{status}&select=id",
                {
                    "status": "processing",
                    "claimed_from_status": status,
                    "attempt_count": int(job.get("attempt_count") or 0) + 1,
                    "claimed_at": _utc_now(),
                    "updated_at": _utc_now(),
                },
                prefer="return=representation",
            )
            if updated:
                return {**job, "status": "processing", "claimed_from_status": status}

        stale_before = datetime.now(timezone.utc) - timedelta(minutes=STALE_CLAIM_MINUTES)
        stale_rows = self._rest(
            "GET",
            "curriculum_processing_jobs",
            f"status=eq.processing&claimed_at=lt.{urllib.parse.quote(stale_before.isoformat(), safe='')}"
            "&select=id,school_id,document_id,status,attempt_count,manifest,claimed_at,claimed_from_status"
            "&order=claimed_at.asc&limit=1",
        )
        if not stale_rows:
            return None
        job = stale_rows[0]
        previous_status = job.get("claimed_from_status")
        if previous_status not in {"queued", "ready_to_delete", "source_deletion_failed"}:
            raise WorkerError(f"Stale job {job['id']} has no valid prior workflow state.")
        claimed_at = urllib.parse.quote(str(job.get("claimed_at") or ""), safe="")
        updated = self._rest(
            "PATCH",
            "curriculum_processing_jobs",
            f"id=eq.{job['id']}&status=eq.processing&claimed_at=eq.{claimed_at}&select=id",
            {
                "claimed_from_status": previous_status,
                "attempt_count": int(job.get("attempt_count") or 0) + 1,
                "claimed_at": _utc_now(),
                "updated_at": _utc_now(),
            },
            prefer="return=representation",
        )
        if not updated:
            return None
        return {**job, "status": "processing", "claimed_from_status": previous_status}

    def _get_document(self, job: dict[str, Any]) -> dict[str, Any]:
        rows = self._rest(
            "GET",
            "curriculum_documents",
            f"id=eq.{job['document_id']}&school_id=eq.{job['school_id']}&select=*",
        )
        if not rows:
            raise WorkerError("The curriculum document metadata no longer exists.")
        return rows[0]

    def _download_for_document(self, document: dict[str, Any]) -> tuple[str, bytes]:
        path = safe_storage_path(
            str(document.get("temporary_storage_path") or ""),
            str(document["school_id"]),
            str(document["id"]),
        )
        content = self._download(path)
        digest = validate_file_payload(
            str(document.get("original_file_name") or ""),
            content,
            str(document.get("original_content_type") or "application/octet-stream"),
        )
        if document.get("original_size_bytes") is not None and int(document["original_size_bytes"]) != len(content):
            raise WorkerError("The uploaded file size no longer matches its saved metadata.")
        existing = self._rest(
            "GET",
            "curriculum_documents",
            f"school_id=eq.{document['school_id']}&source_sha256=eq.{digest}&id=neq.{document['id']}&select=id&limit=1",
        )
        if existing:
            raise WorkerError("This school has already uploaded an identical curriculum document.")
        return digest, content

    def _persist_units(
        self,
        document: dict[str, Any],
        job: dict[str, Any],
        units: list[Unit],
        digest: str,
        started_at: str,
    ) -> dict[str, Any]:
        school_id = document["school_id"]
        document_id = document["id"]
        total_units = len(units)
        low_confidence = sum(1 for unit in units if unit.needs_review or (unit.confidence is not None and unit.confidence < 75))
        ocr_units = sum(1 for unit in units if unit.method == "ocr")
        warnings = [
            f"{unit.reference}: {warning}"
            for unit in units
            for warning in unit.warnings
        ][:500]
        manifest: dict[str, Any] = {
            "total_units": total_units,
            "processed_units": 0,
            "ocr_units": ocr_units,
            "failed_units": 0,
            "low_confidence_units": low_confidence,
            "warnings": warnings,
            "extraction_version": EXTRACTION_VERSION,
            "started_at": started_at,
            "completed_at": _utc_now(),
        }
        source_rows = [
            {
                "school_id": school_id,
                "document_id": document_id,
                "job_id": job["id"],
                "unit_kind": unit.kind,
                "unit_reference": unit.reference,
                "unit_number": unit.number,
                "extracted_text": unit.text,
                "extracted_tables": unit.tables,
                "extraction_method": unit.method,
                "extraction_confidence": unit.confidence,
                "needs_review": unit.needs_review,
                "warnings": unit.warnings,
            }
            for unit in units
        ]
        for start in range(0, len(source_rows), 10):
            self._rest(
                "POST",
                "curriculum_source_units",
                "on_conflict=school_id,document_id,unit_reference",
                source_rows[start:start + 10],
                prefer="resolution=merge-duplicates,return=minimal",
            )
        references = ",".join(urllib.parse.quote(unit.reference, safe=":") for unit in units)
        stored_units = self._rest(
            "GET",
            "curriculum_source_units",
            f"school_id=eq.{school_id}&document_id=eq.{document_id}&unit_reference=in.({references})&select=id,unit_reference&limit={MAX_UNITS}",
        )
        unit_ids = {row["unit_reference"]: row["id"] for row in stored_units}
        if len(unit_ids) != total_units:
            raise WorkerError("Structured source evidence did not persist for every document unit.")

        topics, objectives = extract_curriculum_candidates(units)
        topic_rows: list[dict[str, Any]] = []
        for index, topic in enumerate(topics):
            row_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"curriculum-topic:{document_id}:{topic['unit_reference']}:{index}:{topic['name']}"))
            topic_rows.append({
                "id": row_id,
                "school_id": school_id,
                "document_id": document_id,
                "source_unit_id": unit_ids[topic["unit_reference"]],
                "name": topic["name"],
                "section_number": topic["section_number"],
                "original_text": topic["original_text"],
                "extraction_confidence": next(
                    (unit.confidence for unit in units if unit.reference == topic["unit_reference"]),
                    None,
                ),
                "sort_order": topic["sort_order"],
            })
        for start in range(0, len(topic_rows), 100):
            self._rest("POST", "curriculum_topics", "on_conflict=id", topic_rows[start:start + 100],
                       prefer="resolution=merge-duplicates,return=minimal")

        objective_rows: list[dict[str, Any]] = []
        for objective in objectives:
            row_id = str(uuid.uuid5(
                uuid.NAMESPACE_URL,
                f"curriculum-objective:{document_id}:{objective['unit_reference']}:{objective['section_number']}:{objective['original_text']}",
            ))
            objective_rows.append({
                "id": row_id,
                "school_id": school_id,
                "document_id": document_id,
                "source_unit_id": unit_ids[objective["unit_reference"]],
                "section_number": objective["section_number"],
                "objective_type": objective["objective_type"],
                "original_text": objective["original_text"],
                "sort_order": objective["sort_order"],
                "extraction_confidence": next(
                    (unit.confidence for unit in units if unit.reference == objective["unit_reference"]),
                    None,
                ),
            })
        for start in range(0, len(objective_rows), 100):
            self._rest("POST", "curriculum_objectives", "on_conflict=id", objective_rows[start:start + 100],
                       prefer="resolution=merge-duplicates,return=minimal")

        stored_units = self._rest(
            "GET",
            "curriculum_source_units",
            f"school_id=eq.{school_id}&document_id=eq.{document_id}&select=id&limit={MAX_UNITS}",
        )
        if len(stored_units) != total_units:
            raise WorkerError("Post-save verification found an incomplete source-unit manifest.")
        manifest["processed_units"] = len(stored_units)
        manifest["topic_count"] = len(topic_rows)
        manifest["objective_count"] = len(objective_rows)
        manifest["status"] = "needs_review"
        self._rest(
            "PATCH",
            "curriculum_documents",
            f"id=eq.{document_id}&school_id=eq.{school_id}",
            {"source_sha256": digest, "status": "needs_review", "updated_at": _utc_now()},
            prefer="return=minimal",
        )
        self._rest(
            "PATCH",
            "curriculum_processing_jobs",
            f"id=eq.{job['id']}&school_id=eq.{school_id}",
            {"status": "needs_review", "manifest": manifest, "completed_at": _utc_now(), "error_message": "", "updated_at": _utc_now()},
            prefer="return=minimal",
        )
        self._rest(
            "POST",
            "curriculum_audit_events",
            "",
            {
                "school_id": school_id,
                "document_id": document_id,
                "event_type": "document_extracted",
                "details": {
                    "job_id": job["id"],
                    "source_sha256": digest,
                    "total_units": total_units,
                    "processed_units": total_units,
                    "topics": len(topic_rows),
                    "objectives": len(objective_rows),
                    "extraction_version": EXTRACTION_VERSION,
                },
            },
            prefer="return=minimal",
        )
        return manifest

    def _process(self, job: dict[str, Any], document: dict[str, Any]) -> None:
        started_at = _utc_now()
        try:
            digest, content = self._download_for_document(document)
            units = extract_document(str(document["original_file_name"]), content)
            self._persist_units(document, job, units, digest, started_at)
        except Exception as error:
            reason = _error_message(error)
            previous_manifest = job.get("manifest") if isinstance(job.get("manifest"), dict) else {}
            manifest = {
                **previous_manifest,
                "status": "failed",
                "failed_units": max(1, int(previous_manifest.get("failed_units") or 0)),
                "error": reason,
                "completed_at": _utc_now(),
                "extraction_version": EXTRACTION_VERSION,
            }
            self._rest(
                "PATCH", "curriculum_processing_jobs", f"id=eq.{job['id']}",
                {"status": "failed", "manifest": manifest, "error_message": reason, "completed_at": _utc_now(), "updated_at": _utc_now()},
                prefer="return=minimal",
            )
            self._rest(
                "PATCH", "curriculum_documents", f"id=eq.{document['id']}",
                {"status": "failed", "updated_at": _utc_now()},
                prefer="return=minimal",
            )
            self._rest(
                "POST", "curriculum_audit_events", "",
                {"school_id": document["school_id"], "document_id": document["id"],
                 "event_type": "document_processing_failed",
                 "details": {"job_id": job["id"], "reason": reason}},
                prefer="return=minimal",
            )
            raise

    def _delete_approved_source(self, job: dict[str, Any], document: dict[str, Any]) -> None:
        if not ready_for_source_deletion(document, job):
            raise WorkerError("Source deletion requires approved, fully persisted curriculum.")
        path = safe_storage_path(
            str(document["temporary_storage_path"]),
            str(document["school_id"]),
            str(document["id"]),
        )
        try:
            self._delete_and_verify(path)
            deleted_at = _utc_now()
            manifest = {
                **job["manifest"],
                "source_deleted_at": deleted_at,
                "source_deletion_verified": True,
            }
            self._rest(
                "PATCH", "curriculum_documents", f"id=eq.{document['id']}&school_id=eq.{document['school_id']}",
                {"temporary_storage_path": None, "source_deleted_at": deleted_at, "status": "source_deleted", "updated_at": deleted_at},
                prefer="return=minimal",
            )
            self._rest(
                "PATCH", "curriculum_processing_jobs", f"id=eq.{job['id']}&school_id=eq.{job['school_id']}",
                {"status": "source_deleted", "source_deleted_at": deleted_at, "manifest": manifest,
                 "error_message": "", "updated_at": deleted_at},
                prefer="return=minimal",
            )
            self._rest(
                "POST", "curriculum_audit_events", "",
                {"school_id": document["school_id"], "document_id": document["id"],
                 "event_type": "source_deleted",
                 "details": {"job_id": job["id"], "deleted_at": deleted_at, "verified": True}},
                prefer="return=minimal",
            )
        except Exception as error:
            reason = _error_message(error)
            self._rest(
                "PATCH", "curriculum_processing_jobs", f"id=eq.{job['id']}",
                {"status": "source_deletion_failed", "error_message": reason, "updated_at": _utc_now()},
                prefer="return=minimal",
            )
            self._rest(
                "PATCH", "curriculum_documents", f"id=eq.{document['id']}",
                {"status": "deletion_failed", "updated_at": _utc_now()},
                prefer="return=minimal",
            )
            self._rest(
                "POST", "curriculum_audit_events", "",
                {"school_id": document["school_id"], "document_id": document["id"],
                 "event_type": "source_deletion_failed",
                 "details": {"job_id": job["id"], "reason": reason}},
                prefer="return=minimal",
            )
            raise

    def _cleanup_expired(self) -> int:
        retention_days = max(1, min(int(os.environ.get("CURRICULUM_FAILED_RETENTION_DAYS", "14")), 90))
        cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()
        expired = 0
        active_job_statuses = (
            "queued",
            "processing",
            "needs_review",
            "ready_to_delete",
            "source_deletion_failed",
        )
        for status in ("draft", "uploaded", "failed"):
            rows = self._rest(
                "GET",
                "curriculum_documents",
                f"status=eq.{status}&updated_at=lt.{urllib.parse.quote(cutoff, safe='')}&select=id,school_id,temporary_storage_path&limit=100",
            )
            for document in rows:
                active_jobs = self._rest(
                    "GET",
                    "curriculum_processing_jobs",
                    f"school_id=eq.{document['school_id']}&document_id=eq.{document['id']}"
                    f"&status=in.({','.join(active_job_statuses)})&select=id&limit=1",
                )
                if active_jobs:
                    continue
                path = document.get("temporary_storage_path")
                if path:
                    safe_path = safe_storage_path(str(path), document["school_id"], document["id"])
                    self._delete_and_verify(safe_path)
                expired_at = _utc_now()
                self._rest(
                    "PATCH", "curriculum_documents", f"id=eq.{document['id']}&school_id=eq.{document['school_id']}",
                    {"temporary_storage_path": None, "source_deleted_at": expired_at if path else None,
                     "status": "expired", "updated_at": expired_at},
                    prefer="return=minimal",
                )
                self._rest(
                    "POST", "curriculum_audit_events", "",
                    {"school_id": document["school_id"], "document_id": document["id"],
                     "event_type": "temporary_upload_expired",
                     "details": {"deleted_at": expired_at if path else None, "retention_days": retention_days}},
                    prefer="return=minimal",
                )
                expired += 1
        return expired

    def run(self, max_jobs: int = MAX_WORKER_JOBS) -> int:
        failures = 0
        try:
            self._cleanup_expired()
        except Exception as error:
            failures += 1
            print(f"Curriculum temporary-file cleanup failed: {_error_message(error)}", file=sys.stderr)
        for _ in range(max_jobs):
            try:
                job = self._claim()
                if not job:
                    break
                document = self._get_document(job)
                if job.get("manifest") and document.get("status") in {"approved", "deletion_failed"}:
                    self._delete_approved_source(job, document)
                elif document.get("status") in {"uploaded", "failed"} or (
                    document.get("status") == "needs_review"
                    and job.get("claimed_from_status") == "queued"
                ):
                    self._process(job, document)
                elif document.get("status") == "source_deleted":
                    deleted_at = document.get("source_deleted_at") or _utc_now()
                    self._rest(
                        "PATCH",
                        "curriculum_processing_jobs",
                        f"id=eq.{job['id']}&school_id=eq.{job['school_id']}",
                        {"status": "source_deleted", "source_deleted_at": deleted_at, "updated_at": _utc_now()},
                        prefer="return=minimal",
                    )
                else:
                    raise WorkerError(f"Document status {document.get('status')} cannot be processed by this job.")
            except Exception as error:
                failures += 1
                print(f"Curriculum worker job failed: {_error_message(error)}", file=sys.stderr)
        return 1 if failures else 0


def main() -> int:
    try:
        return SupabaseWorker().run()
    except WorkerError as error:
        print(f"Curriculum worker could not start: {_error_message(error)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
