#!/usr/bin/env python3
"""Bounded worker for authorized past-paper document processing."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from dataclasses import dataclass
from typing import Any

MAX_PAGES = 100
MIN_TEXT_CHARACTERS = 25
MAX_PAGE_TEXT_CHARACTERS = 60_000
USER_AGENT = "CampusConnectPastPaperBot"
QUESTION_START = re.compile(
    r"^\s*(?:(\d{1,2})\s*)?(?:\(([a-z])\))?(?:\(([ivxlcdm]+)\))?\s*[.)]?\s+",
    re.IGNORECASE,
)
MARKS = re.compile(
    r"(?:\[\s*(\d{1,3})\s*(?:marks?)?\s*\]|\(\s*(\d{1,3})\s+marks?\s*\))\s*$",
    re.IGNORECASE,
)
DIAGRAM = re.compile(r"\b(?:figure|diagram|graph|map|image|not to scale)\b", re.IGNORECASE)


class WorkerError(Exception):
    pass


@dataclass
class DownloadedDocument:
    content: bytes
    content_type: str
    canonical_url: str


def _normalized_phrase(value: str) -> str:
    return " ".join(re.sub(r"[\W_]+", " ", value.lower()).split())


def question_fingerprint(question_text: str, metadata: dict[str, Any]) -> str:
    parts = [
        _normalized_phrase(question_text),
        str(metadata.get("syllabus_code") or ""),
        str(metadata.get("syllabus_version") or ""),
        str(metadata.get("examination_year") or ""),
        str(metadata.get("examination_session") or ""),
        str(metadata.get("paper_number") or ""),
        str(metadata.get("variant") or ""),
        str(metadata.get("question_number") or ""),
        str(metadata.get("marks") or ""),
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def validate_pdf_payload(content: bytes, content_type: str, max_bytes: int) -> str:
    if content_type.casefold() not in {"application/pdf", "application/octet-stream"}:
        raise WorkerError(f"Source returned unsupported content type: {content_type}.")
    if not content or len(content) > max_bytes:
        raise WorkerError("PDF is empty or exceeds the configured document size limit.")
    if not content.startswith(b"%PDF-"):
        raise WorkerError("The downloaded file does not have a valid PDF signature.")
    return hashlib.sha256(content).hexdigest()


def classify_question(question_text: str, catalogue: list[dict[str, Any]], source: dict[str, Any]) -> dict[str, Any]:
    matches: dict[str, dict[str, Any]] = {}
    normalized_text = f" {_normalized_phrase(question_text)} "
    for topic in catalogue:
        if any(source.get(field) and topic.get(field) != source.get(field)
               for field in ("curriculum", "subject_name", "syllabus_code", "syllabus_version")):
            continue
        phrases = topic.get("approved_phrases")
        if not isinstance(phrases, list):
            continue
        if any(
            phrase and f" {_normalized_phrase(str(phrase))} " in normalized_text
            for phrase in phrases
        ):
            matches[str(topic["id"])] = topic
    if len(matches) != 1:
        return {
            "syllabus_topic_id": None,
            "topic": None,
            "subtopic": None,
            "classification_confidence": None,
            "classification_status": "NEEDS_REVIEW",
        }
    topic = next(iter(matches.values()))
    return {
        "syllabus_topic_id": topic["id"],
        "topic": topic["topic"],
        "subtopic": topic.get("subtopic") or "",
        "classification_confidence": 95,
        "classification_status": "CLASSIFIED",
    }


def segment_questions(pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    questions: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    current_parent_number: str | None = None

    def finish() -> None:
        nonlocal current
        if not current:
            return
        text = "\n".join(current.pop("_lines")).strip()
        marks_match = MARKS.search(text)
        marks = int(marks_match.group(1)) if marks_match else None
        if marks_match:
            text = text[:marks_match.start()].rstrip()
        current["question_text"] = text
        current["marks"] = marks
        current["extraction_status"] = (
            "COMPLETE" if len(text) >= 10 and marks is not None
            else "NEEDS_REVIEW" if len(text) >= 10
            else "INCOMPLETE"
        )
        current["question_structure"] = {
            "parent_number": current["parent_number"],
            "part_number": current["question_number"],
            "table_references": current["table_references"],
        }
        questions.append(current)
        current = None

    for page in pages:
        page_number = int(page["page_number"])
        text = str(page.get("text_content", ""))
        diagram_references = page.get("diagram_references", [])
        for line in text.splitlines():
            match = QUESTION_START.match(line)
            if match and any(match.groups()):
                number, letter, roman = match.groups()
                if number:
                    current_parent_number = number
                elif not current_parent_number:
                    continue
                parent = number or current_parent_number
                part = f"({letter})" if letter else ""
                part += f"({roman.lower()})" if roman else ""
                question_number = f"{parent}{part}"
                if current is None or current["question_number"] != question_number:
                    finish()
                    current = {
                        "parent_number": parent,
                        "question_number": question_number,
                        "page_start": page_number,
                        "page_end": page_number,
                        "diagram_references": [],
                        "table_references": [],
                        "_lines": [],
                    }
                current["page_end"] = page_number
                current["_lines"].append(QUESTION_START.sub("", line, count=1))
            elif current and line.strip():
                current["page_end"] = page_number
                current["_lines"].append(line.strip())
            if current and diagram_references:
                current["diagram_references"] = sorted(set(
                    current["diagram_references"] + [str(value) for value in diagram_references]
                ))
            if current and page.get("tables"):
                current["table_references"] = sorted(set(
                    current["table_references"]
                    + [f"page:{page_number}:table:{table_index + 1}"
                       for table_index, _ in enumerate(page["tables"])]
                ))
            if current and DIAGRAM.search(line):
                current["diagram_references"] = sorted(set(
                    current["diagram_references"] + [f"page:{page_number}"]
                ))
    finish()
    return questions


def _robots_allowed(url: urllib.parse.ParseResult) -> bool:
    robots_url = urllib.parse.urlunparse((url.scheme, url.netloc, "/robots.txt", "", "", ""))
    request = urllib.request.Request(robots_url, headers={"User-Agent": USER_AGENT})
    try:
        opener = urllib.request.build_opener(SameHostRedirectHandler(str(url.hostname)))
        with opener.open(request, timeout=15) as response:
            rules = response.read(256 * 1024).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return True
        raise WorkerError(f"robots.txt returned HTTP {error.code}.") from error
    parser = urllib.robotparser.RobotFileParser()
    parser.set_url(robots_url)
    parser.parse(rules.splitlines())
    return parser.can_fetch(USER_AGENT, urllib.parse.urlunparse(url))


class SameHostRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, expected_host: str) -> None:
        super().__init__()
        self.expected_host = expected_host.casefold()
        self.redirects = 0

    def redirect_request(self, request: Any, response: Any, code: int, message: str, headers: Any, new_url: str) -> Any:
        redirected = urllib.parse.urlparse(new_url)
        self.redirects += 1
        if (self.redirects > 3 or redirected.scheme != "https"
                or redirected.hostname != self.expected_host or redirected.port
                or redirected.username or redirected.password):
            raise WorkerError("Cross-host or non-HTTPS redirects are not followed.")
        return super().redirect_request(request, response, code, message, headers, new_url)


def download_pdf(item: dict[str, Any]) -> DownloadedDocument:
    original = urllib.parse.urlparse(str(item["canonical_url"]))
    expected_host = str(item["canonical_host"]).casefold()
    if (original.scheme != "https" or original.hostname != expected_host or original.port
            or original.username or original.password):
        raise WorkerError("The PDF URL is outside the registered HTTPS source host.")
    if any(re.search(r"token|key|auth|secret|signature|session|password|credential", key, re.I)
           for key, _ in urllib.parse.parse_qsl(original.query)):
        raise WorkerError("Credential-like PDF URL parameters are not permitted.")
    if not _robots_allowed(original):
        raise WorkerError("robots.txt disallows access to this PDF.")
    opener = urllib.request.build_opener(SameHostRedirectHandler(expected_host))
    request = urllib.request.Request(
        str(item["canonical_url"]),
        headers={"Accept": "application/pdf, application/octet-stream;q=0.8", "User-Agent": USER_AGENT},
    )
    try:
        response = opener.open(request, timeout=25)
    except urllib.error.HTTPError as error:
        raise WorkerError(f"Document source returned HTTP {error.code}.") from error
    with response:
        content_type = response.headers.get_content_type().casefold()
        limit = min(int(item["document_max_bytes"]), 50 * 1024 * 1024)
        declared_size = int(response.headers.get("Content-Length", "0") or "0")
        if declared_size > limit:
            raise WorkerError("PDF exceeds the configured document size limit.")
        content = response.read(limit + 1)
        if len(content) > limit:
            raise WorkerError("PDF exceeds the configured document size limit.")
        validate_pdf_payload(content, content_type, limit)
        final_url = urllib.parse.urlparse(response.geturl())
        if final_url.scheme != "https" or final_url.hostname != expected_host:
            raise WorkerError("The final PDF URL is outside the registered HTTPS source host.")
        return DownloadedDocument(content, "application/pdf", response.geturl())


def extract_pdf(content: bytes, ocr_allowed: bool) -> dict[str, Any]:
    try:
        import fitz
    except ImportError as error:
        raise WorkerError("PyMuPDF is not installed on this worker.") from error

    document = fitz.open(stream=content, filetype="pdf")
    if document.page_count < 1 or document.page_count > MAX_PAGES:
        raise WorkerError(f"PDF page count must be between 1 and {MAX_PAGES}.")
    pages: list[dict[str, Any]] = []
    warnings: list[str] = []
    for index, page in enumerate(document):
        text = page.get_text("text", sort=True).strip()
        method = "pdf-text"
        confidence: float | None = None
        needs_review = False
        if len(text) < MIN_TEXT_CHARACTERS:
            if ocr_allowed:
                try:
                    import pytesseract
                    from PIL import Image
                    from pytesseract import Output
                    import io
                    image_bytes = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).tobytes("png")
                    image = Image.open(io.BytesIO(image_bytes))
                    ocr_data = pytesseract.image_to_data(image, output_type=Output.DICT, config="--psm 6")
                    words: list[str] = []
                    confidences: list[float] = []
                    for word, raw_confidence in zip(ocr_data["text"], ocr_data["conf"]):
                        if word.strip():
                            words.append(word)
                            try:
                                value = float(raw_confidence)
                                if value >= 0:
                                    confidences.append(value)
                            except (TypeError, ValueError):
                                pass
                    text = " ".join(words).strip()
                    confidence = round(sum(confidences) / len(confidences), 2) if confidences else None
                    method = "ocr" if text else "empty"
                    needs_review = not text or confidence is None or confidence < 75
                except (ImportError, OSError, RuntimeError) as error:
                    warnings.append(f"Page {index + 1} OCR failed: {error}")
                    method = "empty"
                    needs_review = True
            else:
                method = "empty"
                needs_review = True
        tables: list[list[list[str]]] = []
        try:
            found = page.find_tables()
            for table in found.tables[:20]:
                tables.append([
                    [str(cell or "")[:1000] for cell in row[:30]]
                    for row in table.extract()[:100]
                ])
        except (AttributeError, RuntimeError, ValueError):
            warnings.append(f"Page {index + 1} table extraction needs review.")
            needs_review = True
        diagram_references = [f"page:{index + 1}"] if page.get_images(full=True) or DIAGRAM.search(text) else []
        instructions = [
            line.strip()[:500] for line in text.splitlines()
            if re.search(r"\b(?:answer all|answer the|do not|show your|write your|each question|you should)\b", line, re.I)
        ][:30]
        pages.append({
            "page_number": index + 1,
            "text_content": text[:MAX_PAGE_TEXT_CHARACTERS],
            "tables": tables,
            "diagram_references": diagram_references,
            "instructions": instructions,
            "extraction_method": method,
            "ocr_confidence": confidence,
            "needs_review": needs_review,
        })
    questions = segment_questions(pages)
    if not questions:
        warnings.append("No numbered questions were confidently segmented.")
    return {"page_count": len(pages), "pages": pages, "questions": questions, "warnings": warnings}


def _api_request(action: str, values: dict[str, Any]) -> dict[str, Any]:
    endpoint = os.environ.get("PAST_PAPER_FUNCTION_URL", "").strip()
    if not endpoint:
        supabase_url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
        if supabase_url:
            endpoint = f"{supabase_url}/functions/v1/past-paper-pipeline"
    anon_key = os.environ.get("SUPABASE_ANON_KEY", "").strip()
    secret = os.environ.get("PAPER_PIPELINE_WORKER_SECRET", "").strip()
    if not endpoint or not anon_key or not secret:
        raise WorkerError(
            "Set SUPABASE_URL or PAST_PAPER_FUNCTION_URL, SUPABASE_ANON_KEY, and PAPER_PIPELINE_WORKER_SECRET."
        )
    body = json.dumps({"action": action, **values}).encode()
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={
            "Content-Type": "application/json",
            "apikey": anon_key,
            "Authorization": f"Bearer {anon_key}",
            "x-paper-worker-secret": secret,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read(5 * 1024 * 1024))
    except urllib.error.HTTPError as error:
        message = error.read(16 * 1024).decode("utf-8", errors="replace")
        raise WorkerError(f"Pipeline API returned HTTP {error.code}: {message}") from error
    if not isinstance(result, dict):
        raise WorkerError("Pipeline API returned an invalid response.")
    return result


def _upload_signed_url(url: str, content: bytes, content_type: str) -> None:
    request = urllib.request.Request(
        url,
        data=content,
        headers={"Content-Type": content_type, "x-upsert": "false"},
        method="PUT",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.status not in (200, 201):
                raise WorkerError(f"Private storage upload returned HTTP {response.status}.")
    except urllib.error.HTTPError as error:
        raise WorkerError(f"Private storage upload returned HTTP {error.code}.") from error


def process_item(task: dict[str, Any]) -> None:
    item = task["item"]
    source = task["source"]
    downloaded = download_pdf(item)
    checksum = validate_pdf_payload(
        downloaded.content, downloaded.content_type, min(int(item["document_max_bytes"]), 50 * 1024 * 1024)
    )
    document_path = task["documentPath"]
    extraction_path = task["extractionPath"]
    _upload_signed_url(task["documentUploadUrl"], downloaded.content, "application/pdf")
    download_result = _api_request("worker-downloaded", {
        "itemId": item["id"],
        "documentPath": document_path,
        "sha256": checksum,
        "fileSize": len(downloaded.content),
        "canonicalUrl": downloaded.canonical_url,
    })
    if download_result.get("status") == "DUPLICATE":
        return
    extracted = extract_pdf(downloaded.content, bool(source.get("ocr_allowed")))
    for question in extracted["questions"]:
        question.update(classify_question(question["question_text"], task.get("syllabusTopics", []), source))
    manifest = json.dumps(extracted, ensure_ascii=False, separators=(",", ":")).encode()
    _upload_signed_url(task["extractionUploadUrl"], manifest, "application/json")
    _api_request("worker-complete", {
        "itemId": item["id"],
        "documentPath": document_path,
        "extractionPath": extraction_path,
        "sha256": checksum,
        "fileSize": len(downloaded.content),
        "pageCount": extracted["page_count"],
        "canonicalUrl": downloaded.canonical_url,
        "contentType": downloaded.content_type,
    })


def run_worker(max_items: int = 1) -> int:
    failures = 0
    schedule_result = _api_request("scheduled-discover", {})
    for result in schedule_result.get("scheduledSources", []):
        if result.get("error"):
            failures += 1
            print(f"Scheduled source {result.get('sourceId')} failed: {result['error']}", file=sys.stderr)
    for _ in range(max_items):
        task = _api_request("worker-claim", {}).get("task")
        if not task:
            break
        try:
            process_item(task)
        except Exception as error:
            failures += 1
            try:
                _api_request("worker-fail", {
                    "itemId": task["item"]["id"],
                    "documentPath": task["documentPath"],
                    "extractionPath": task["extractionPath"],
                    "failureReason": str(error)[:1000],
                    "retryable": True,
                })
            except Exception as report_error:
                print(f"Could not record worker failure: {report_error}", file=sys.stderr)
            print(f"Past-paper item {task['item']['id']} failed: {error}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(run_worker())
    except Exception as error:
        print(f"Past-paper worker failed: {error}", file=sys.stderr)
        sys.exit(1)
