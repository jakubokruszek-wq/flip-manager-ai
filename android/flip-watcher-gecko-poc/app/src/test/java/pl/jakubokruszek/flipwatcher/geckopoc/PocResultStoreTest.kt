package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class PocResultStoreTest {
    private fun run(n: Int) = StoredRun("GROUP_SCAN", "s$n", "f$n", "OK", listOf("100000000000$n"), listOf("https://www.facebook.com/groups/1/posts/100000000000$n/"), 0, mapOf("k" to "v"))

    @Test fun `round trip keeps newest first and caps history`() {
        val dir = Files.createTempDirectory("poc").toFile()
        val store = PocResultStore(dir.resolve(PocResultStore.DIRECTORY))
        repeat(PocResultStore.LIMIT + 5) { store.append(run(it)) }
        val runs = store.runs()
        assertEquals(PocResultStore.LIMIT, runs.size)
        assertEquals("s${PocResultStore.LIMIT + 4}", runs.first().startedAt)
        assertEquals(mapOf("k" to "v"), runs.first().notes)
    }

    @Test fun `writes only its own file inside its own directory`() {
        val dir = Files.createTempDirectory("poc").toFile()
        PocResultStore(dir.resolve(PocResultStore.DIRECTORY)).append(run(1))
        val files = dir.walkTopDown().filter { it.isFile }.map { it.relativeTo(dir).path }.toList()
        assertEquals(listOf("${PocResultStore.DIRECTORY}/${PocResultStore.FILE_NAME}"), files)
    }

    @Test fun `stored data has ids and counters only, no post text or secrets`() {
        val report = ScanReport(ScanStatus.OK, listOf(FoundPost("1000000000001", ScanProtocol.canonicalPermalink("1", "1000000000001"), "DOM_LINK")), 0, mapOf("visibleCards" to 1), 0, null)
        val encoded = PocResultStore.encode(listOf(PocResultStore.fromReport("GROUP_SCAN", "a", "b", report)))
        assertTrue(encoded.contains("1000000000001"))
        listOf("text", "author", "cookie", "token", "password", "media").forEach { assertTrue(it, !encoded.contains(it, ignoreCase = true)) }
    }

    @Test fun `corrupt file reads as empty instead of crashing`() {
        val dir = Files.createTempDirectory("poc").toFile().resolve(PocResultStore.DIRECTORY).apply { mkdirs() }
        dir.resolve(PocResultStore.FILE_NAME).writeText("{not json")
        assertEquals(emptyList<StoredRun>(), PocResultStore(dir).runs())
    }
}
