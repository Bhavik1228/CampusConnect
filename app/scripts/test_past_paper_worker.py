import unittest

import hashlib
import os
import sys
import types
import unittest
from email.message import Message
from unittest.mock import patch

from past_paper_worker import _api_request, classify_question, segment_questions
from past_paper_worker import DownloadedDocument, WorkerError, download_pdf, extract_pdf, question_fingerprint
from past_paper_worker import validate_pdf_payload


class FakeResponse:
    def __init__(self, content, content_type="application/pdf", url="https://papers.example/paper.pdf"):
        self.content = content
        self.url = url
        self.headers = Message()
        self.headers["Content-Type"] = content_type
        self.headers["Content-Length"] = str(len(content))
        self.status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self, size=-1):
        return self.content if size < 0 else self.content[:size]

    def geturl(self):
        return self.url


class FakeOpener:
    def __init__(self, response):
        self.response = response

    def open(self, *_args, **_kwargs):
        return self.response


class RetrievalTests(unittest.TestCase):
    def test_signature_content_type_size_and_checksum(self):
        data = b"%PDF-1.7\npaper"
        checksum = validate_pdf_payload(data, "application/pdf", 100)
        self.assertEqual(checksum, hashlib.sha256(data).hexdigest())
        with self.assertRaises(WorkerError):
            validate_pdf_payload(b"<html>not a PDF</html>", "application/pdf", 100)
        with self.assertRaises(WorkerError):
            validate_pdf_payload(data, "text/html", 100)
        with self.assertRaises(WorkerError):
            validate_pdf_payload(data, "application/pdf", 4)

    def test_download_checks_robots_signature_host_and_response_type(self):
        item = {
            "canonical_url": "https://papers.example/paper.pdf",
            "canonical_host": "papers.example",
            "document_max_bytes": 100,
        }
        content = b"%PDF-1.7\npaper"
        response = FakeResponse(content)
        with patch("past_paper_worker._robots_allowed", return_value=True), patch(
            "past_paper_worker.urllib.request.build_opener",
            return_value=FakeOpener(response),
        ):
            result = download_pdf(item)
        self.assertIsInstance(result, DownloadedDocument)
        self.assertEqual(result.content, content)

        with patch("past_paper_worker._robots_allowed", return_value=False):
            with self.assertRaisesRegex(WorkerError, "robots.txt"):
                download_pdf(item)

    def test_checksum_identity_is_metadata_aware(self):
        metadata = {
            "syllabus_code": "0610",
            "syllabus_version": "2025",
            "examination_year": 2025,
            "examination_session": "s",
            "paper_number": "2",
            "variant": "1",
            "question_number": "1(a)",
            "marks": 3,
        }
        first = question_fingerprint("Explain cell structure.", metadata)
        self.assertEqual(first, question_fingerprint("Explain cell structure.", metadata))
        self.assertNotEqual(first, question_fingerprint(
            "Explain cell structure.", {**metadata, "paper_number": "4"}
        ))


class WorkerConnectionTests(unittest.TestCase):
    def test_api_url_is_derived_from_supabase_url(self):
        response = FakeResponse(b"{}")
        with patch.dict(os.environ, {
            "SUPABASE_URL": "https://campus.example/",
            "SUPABASE_ANON_KEY": "anon-key",
            "PAPER_PIPELINE_WORKER_SECRET": "worker-secret",
        }, clear=True), patch(
            "past_paper_worker.urllib.request.urlopen",
            return_value=response,
        ) as urlopen:
            _api_request("scheduled-discover", {})

        self.assertEqual(
            urlopen.call_args.args[0].full_url,
            "https://campus.example/functions/v1/past-paper-pipeline",
        )


class SegmentationTests(unittest.TestCase):
    def test_subquestions_are_distinct_and_keep_multipage_range(self):
        questions = segment_questions([
            {
                "page_number": 1,
                "text_content": "1 (a) Calculate the area. [2]\n(b)(i) Explain your answer.",
                "tables": [["result"]],
                "diagram_references": ["page:1"],
            },
            {
                "page_number": 2,
                "text_content": "continued using the diagram. [3]\n(b)(ii) State one limitation. [1]",
                "diagram_references": ["page:2"],
            },
        ])
        self.assertEqual([q["question_number"] for q in questions], ["1(a)", "1(b)(i)", "1(b)(ii)"])
        self.assertEqual(questions[1]["page_start"], 1)
        self.assertEqual(questions[1]["page_end"], 2)
        self.assertEqual(questions[0]["marks"], 2)
        self.assertEqual(questions[2]["marks"], 1)
        self.assertIn("page:2", questions[1]["diagram_references"])
        self.assertIn("page:1:table:1", questions[0]["question_structure"]["table_references"])

    def test_missing_marks_and_empty_text_require_review(self):
        questions = segment_questions([{
            "page_number": 1,
            "text_content": "1 (a) Describe what happens.",
            "diagram_references": [],
        }])
        self.assertEqual(questions[0]["extraction_status"], "NEEDS_REVIEW")
        self.assertIsNone(questions[0]["marks"])


class ClassificationTests(unittest.TestCase):
    def setUp(self):
        self.source = {
            "curriculum": "IGCSE",
            "subject_name": "Biology",
            "syllabus_code": "0610",
            "syllabus_version": "2025",
        }
        self.catalogue = [{
            "id": "topic-id",
            **self.source,
            "topic": "Cell structure",
            "subtopic": "Cell structure and organisation",
            "approved_phrases": ["cell membrane"],
        }]

    def test_unique_curated_phrase_classifies(self):
        result = classify_question("Describe the role of the cell membrane.", self.catalogue, self.source)
        self.assertEqual(result["syllabus_topic_id"], "topic-id")
        self.assertEqual(result["classification_status"], "CLASSIFIED")

    def test_unmatched_or_ambiguous_topic_needs_review(self):
        self.assertEqual(
            classify_question("Describe respiration.", self.catalogue, self.source)["classification_status"],
            "NEEDS_REVIEW",
        )
        ambiguous = self.catalogue + [{**self.catalogue[0], "id": "second-topic", "topic": "Other"}]
        self.assertEqual(
            classify_question("Describe the cell membrane.", ambiguous, self.source)["classification_status"],
            "NEEDS_REVIEW",
        )


class ExtractionTests(unittest.TestCase):
    def test_text_pdf_extraction_retains_pages_and_marks(self):
        try:
            import fitz
        except ImportError:
            self.skipTest("PyMuPDF is not installed.")
        document = fitz.open()
        page = document.new_page()
        page.insert_text((72, 72), "1 (a) Describe the cell membrane. [2]")
        result = extract_pdf(document.tobytes(), ocr_allowed=False)
        self.assertEqual(result["page_count"], 1)
        self.assertEqual(result["questions"][0]["question_number"], "1(a)")
        self.assertEqual(result["questions"][0]["marks"], 2)

    def test_scanned_page_uses_ocr_and_flags_low_confidence(self):
        class FakePage:
            def get_text(self, *_args, **_kwargs):
                return ""

            def get_pixmap(self, **_kwargs):
                return types.SimpleNamespace(tobytes=lambda _format: b"image")

            def find_tables(self):
                return types.SimpleNamespace(tables=[])

            def get_images(self, **_kwargs):
                return []

        class FakeDocument:
            page_count = 1

            def __iter__(self):
                return iter([FakePage()])

        fake_fitz = types.ModuleType("fitz")
        fake_fitz.Matrix = lambda *_args: None
        fake_fitz.open = lambda **_kwargs: FakeDocument()

        fake_pytesseract = types.ModuleType("pytesseract")
        fake_pytesseract.Output = types.SimpleNamespace(DICT="dict")
        fake_pytesseract.image_to_data = lambda *_args, **_kwargs: {
            "text": ["1", "(a)", "Describe", "cells"],
            "conf": ["90", "90", "40", "40"],
        }
        fake_pil = types.ModuleType("PIL")
        fake_pil.Image = types.SimpleNamespace(open=lambda _image: object())

        with patch.dict(sys.modules, {
            "fitz": fake_fitz,
            "pytesseract": fake_pytesseract,
            "PIL": fake_pil,
        }):
            result = extract_pdf(b"%PDF-1.7", ocr_allowed=True)
        self.assertEqual(result["pages"][0]["extraction_method"], "ocr")
        self.assertEqual(result["pages"][0]["ocr_confidence"], 65)
        self.assertTrue(result["pages"][0]["needs_review"])


if __name__ == "__main__":
    unittest.main()
