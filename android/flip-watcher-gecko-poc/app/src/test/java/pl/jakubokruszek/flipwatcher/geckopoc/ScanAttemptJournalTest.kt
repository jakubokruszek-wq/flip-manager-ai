package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScanAttemptJournalTest {
    private fun summary(consumed: Boolean = true, stage: String? = null,
        status: String? = null, posts: Int = 0, rejected: Int = 0,
        saveError: String? = null) =
        ScanAttemptJournal.summary(consumed, stage, status, posts, rejected,
            "2026-10-17T23:00:00Z", null, saveError)

    @Test fun `unused one shot has no result claim`() {
        assertTrue(summary(consumed = false).contains("niewykorzystana"))
    }

    @Test fun `legacy consumed permission never claims scan succeeded`() {
        val text = summary()
        assertTrue(text.contains("Brak zapisanego statusu"))
        assertTrue(text.contains("nie wiadomo"))
        assertFalse(text.contains("postów:"))
    }

    @Test fun `started but not finished is treated as unknown interruption`() {
        val text = summary(stage = "STARTED", status = "PENDING")
        assertTrue(text.contains("brak potwierdzonego zakończenia"))
        assertTrue(text.contains("Limit pozostaje wykorzystany"))
    }

    @Test fun `completed scan includes status, post count and rejection count`() {
        val text = summary(stage = "FINISHED", status = "NO_POSTS", posts = 0, rejected = 7)
        assertTrue(text.contains("NO_POSTS"))
        assertTrue(text.contains("postów: 0"))
        assertTrue(text.contains("odrzucone: 7"))
    }

    @Test fun `storage error is shown without authorizing another scan`() {
        val text = summary(stage = "FINISHED", status = "OK", posts = 2, saveError = "RESULT_WRITE_FAILED:IOException")
        assertTrue(text.contains("RESULT_WRITE_FAILED:IOException"))
        assertTrue(text.contains("postów: 2"))
    }

    @Test fun `aborted attempt reports no request sent`() {
        val text = summary(stage = "ABORTED", status = "NO_REQUEST_SENT")
        assertTrue(text.contains("NO_REQUEST_SENT"))
        assertTrue(text.contains("limit pozostaje wykorzystany"))
    }
}
