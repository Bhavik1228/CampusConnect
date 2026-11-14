import io
import unittest
import zipfile
from unittest.mock import patch

from curriculum_worker import (
    BUCKET,
    SupabaseWorker,
    Unit,
    WorkerError,
    extract_curriculum_candidates,
    extract_document,
    ready_for_source_deletion,
    safe_storage_path,
    validate_file_payload,
)


def office_archive(member):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr(member, "<document/>")
    return buffer.getvalue()


class UploadValidationTests(unittest.TestCase):
    def test_pdf_signature_and_size_are_checked(self):
        digest = validate_file_payload("syllabus.pdf", b"%PDF-1.7\ncontent")
        self.assertEqual(len(digest), 64)
        with self.assertRaisesRegex(WorkerError, "signature"):
            validate_file_payload("syllabus.pdf", b"<html>not a PDF</html>")
        with self.assertRaisesRegex(WorkerError, "empty"):
            validate_file_payload("syllabus.txt", b"")
        with self.assertRaisesRegex(WorkerError, "format"):
            validate_file_payload("syllabus.exe", b"binary")

    def test_office_signature_matches_extension_and_archive_is_valid(self):
        content = office_archive("word/document.xml")
        self.assertEqual(len(validate_file_payload("curriculum.docx", content)), 64)
        with self.assertRaisesRegex(WorkerError, "does not match"):
            validate_file_payload("curriculum.pptx", content)
        with self.assertRaisesRegex(WorkerError, "malformed"):
            validate_file_payload("curriculum.docx", b"PKbroken")

    def test_text_formats_reject_binary_and_mismatched_mime(self):
        with self.assertRaisesRegex(WorkerError, "UTF-8"):
            validate_file_payload("plan.csv", b"\xff\x00")
        with self.assertRaisesRegex(WorkerError, "content type"):
            validate_file_payload("plan.csv", b"name,topic\nA,B", "application/pdf")
        self.assertEqual(len(validate_file_payload("plan.csv", b"name,topic\nA,B")), 64)

    def test_storage_path_is_scoped_to_one_school_and_document(self):
        self.assertEqual(
            safe_storage_path("school-id/document-id/plan.pdf", "school-id", "document-id"),
            "school-id/document-id/plan.pdf",
        )
        for path in (
            "../document-id/plan.pdf",
            "another-school/document-id/plan.pdf",
            "school-id/document-id/../plan.pdf",
            "school-id\\document-id\\plan.pdf",
        ):
            with self.subTest(path=path), self.assertRaises(WorkerError):
                safe_storage_path(path, "school-id", "document-id")


class ExtractionTests(unittest.TestCase):
    def test_text_and_csv_keep_readable_text_and_row_relationships(self):
        text_units = extract_document("objectives.txt", b"1.1 Describe cell structure.\n")
        self.assertEqual(text_units[0].kind, "text")
        self.assertEqual(text_units[0].text, "1.1 Describe cell structure.")

        csv_units = extract_document("scheme.csv", b"Topic,Objective\nCells,Describe cell structure\n")
        self.assertEqual(csv_units[0].kind, "worksheet")
        self.assertEqual(csv_units[0].tables, [[
            ["Topic", "Objective"],
            ["Cells", "Describe cell structure"],
        ]])

    def test_numbered_syllabus_objectives_keep_original_wording_and_source(self):
        topics, objectives = extract_curriculum_candidates([
            Unit(
                kind="page",
                reference="page:4",
                number=4,
                text="1.1 Describe the structure of a typical cell.\n"
                "1.2 State one function of the cell membrane.\n"
                "2025 © Cambridge International",
                confidence=91,
            ),
        ])
        self.assertEqual(topics, [])
        self.assertEqual(len(objectives), 2)
        self.assertEqual(objectives[0]["original_text"], "1.1 Describe the structure of a typical cell.")
        self.assertEqual(objectives[1]["unit_reference"], "page:4")

    def test_pdf_pages_are_extracted_as_independent_units(self):
        import fitz

        source = fitz.open()
        for value in ("1.1 Describe cell structure.", "1.2 State a cell function."):
            page = source.new_page()
            page.insert_text((72, 72), value)
        units = extract_document("syllabus.pdf", source.tobytes())
        self.assertEqual([unit.reference for unit in units], ["page:1", "page:2"])
        self.assertIn("Describe cell structure", units[0].text)

    def test_docx_headings_and_tables_are_preserved(self):
        from docx import Document

        source = Document()
        source.add_paragraph("Cell structure", style="Heading 1")
        source.add_paragraph("1.1 Describe cell structure.")
        table = source.add_table(rows=1, cols=2)
        table.rows[0].cells[0].text = "Cell"
        table.rows[0].cells[1].text = "Function"
        buffer = io.BytesIO()
        source.save(buffer)
        units = extract_document("syllabus.docx", buffer.getvalue())
        self.assertEqual(units[0].headings[0]["text"], "Cell structure")
        self.assertEqual(units[0].tables[0][0], ["Cell", "Function"])

    def test_spreadsheet_and_presentation_keep_unit_boundaries(self):
        import openpyxl
        from pptx import Presentation

        workbook = openpyxl.Workbook()
        workbook.active.title = "Objectives"
        workbook.active.append(["Section", "Objective"])
        workbook.active.append(["1.1", "Describe cell structure"])
        workbook.create_sheet("Practical")
        sheet_buffer = io.BytesIO()
        workbook.save(sheet_buffer)
        sheets = extract_document("scheme.xlsx", sheet_buffer.getvalue())
        self.assertEqual([unit.reference for unit in sheets], ["worksheet:Objectives", "worksheet:Practical"])
        self.assertIn("Describe cell structure", sheets[0].text)

        presentation = Presentation()
        slide = presentation.slides.add_slide(presentation.slide_layouts[0])
        slide.shapes.title.text = "Cell structure"
        slide.placeholders[1].text = "1.1 Describe cell structure."
        slide_buffer = io.BytesIO()
        presentation.save(slide_buffer)
        slides = extract_document("lessons.pptx", slide_buffer.getvalue())
        self.assertEqual(slides[0].reference, "slide:1")
        self.assertEqual(slides[0].headings[0]["text"], "Cell structure")

    def test_source_deletion_requires_approval_and_complete_manifest(self):
        document = {"status": "approved", "temporary_storage_path": "school/doc/file.pdf"}
        job = {
            "status": "processing",
            "claimed_from_status": "ready_to_delete",
            "manifest": {"total_units": 5, "processed_units": 5, "failed_units": 0},
        }
        self.assertTrue(ready_for_source_deletion(document, job))
        self.assertFalse(ready_for_source_deletion({**document, "status": "needs_review"}, job))
        self.assertFalse(ready_for_source_deletion(document, {
            **job, "manifest": {"total_units": 5, "processed_units": 4, "failed_units": 1},
        }))


class WorkerRecoveryTests(unittest.TestCase):
    def test_source_download_uses_the_private_curriculum_bucket(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def read(self, _limit):
                return b"source"

        worker = object.__new__(SupabaseWorker)
        worker.base_url = "https://school.example"
        worker.service_key = "test-key"
        with patch("urllib.request.urlopen", return_value=Response()) as open_url:
            self.assertEqual(worker._download("school/doc/plan.pdf"), b"source")
        request = open_url.call_args.args[0]
        self.assertIn(f"/storage/v1/object/{BUCKET}/school/doc/plan.pdf", request.full_url)

    def test_stale_worker_claim_is_recovered_with_compare_and_set(self):
        worker = object.__new__(SupabaseWorker)
        old_claimed_at = "2020-01-01T00:00:00+00:00"
        stale_job = {
            "id": "job-id",
            "school_id": "school-id",
            "document_id": "document-id",
            "status": "processing",
            "attempt_count": 1,
            "manifest": {},
            "claimed_at": old_claimed_at,
            "claimed_from_status": "queued",
        }
        calls = []

        def fake_rest(method, table, query="", payload=None, prefer=None):
            calls.append((method, table, query, payload, prefer))
            if method == "GET" and "status=eq.processing" in query:
                return [stale_job]
            if method == "PATCH" and "status=eq.processing" in query:
                return [{"id": "job-id"}]
            return []

        worker._rest = fake_rest
        claimed = worker._claim()

        self.assertEqual(claimed["claimed_from_status"], "queued")
        self.assertEqual(claimed["attempt_count"], 1)
        recovery_update = calls[-1]
        self.assertIn("claimed_at=eq.2020-01-01T00%3A00%3A00%2B00%3A00", recovery_update[2])
        self.assertEqual(recovery_update[3]["attempt_count"], 2)


if __name__ == "__main__":
    unittest.main()
