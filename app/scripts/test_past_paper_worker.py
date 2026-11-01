import unittest

from past_paper_worker import classify_question, segment_questions


class SegmentationTests(unittest.TestCase):
    def test_subquestions_are_distinct_and_keep_multipage_range(self):
        questions = segment_questions([
            {
                "page_number": 1,
                "text_content": "1 (a) Calculate the area. [2]\n(b)(i) Explain your answer.",
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


if __name__ == "__main__":
    unittest.main()
