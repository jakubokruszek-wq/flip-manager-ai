package pl.jakubokruszek.flipcollector.watcher

import kotlinx.coroutines.delay

/** A bundled, fictional post used only by the demo scan. Nothing here comes from Facebook. */
data class DemoPost(val id: String, val text: String, val isOffer: Boolean)

/**
 * Test data for the demo scan. Every name carries "DEMO" so a screenshot or a
 * report can never be mistaken for real results. These posts never leave the
 * phone: the demo executor makes no network call.
 */
object DemoData {
    const val GROUP_ID = "demo-lodz"
    val group = WatchedGroup(id = GROUP_ID, name = "DEMO · Mieszkania Łódź (dane testowe)", url = "demo://flip-collector/groups/lodz")
    val groups: List<WatchedGroup> = listOf(group)

    val posts: List<DemoPost> = listOf(
        DemoPost("demo-1", "DEMO: Sprzedam 2 pokoje, 38 m², Bałuty, 289 000 zł", isOffer = true),
        DemoPost("demo-2", "DEMO: Szukam mieszkania do wynajęcia na Widzewie", isOffer = false),
        DemoPost("demo-3", "DEMO: Sprzedam kawalerkę 27 m² do remontu, Polesie, 199 000 zł", isOffer = true),
        DemoPost("demo-4", "DEMO: Polecicie ekipę remontową?", isOffer = false),
        DemoPost("demo-5", "DEMO: Sprzedam 3 pokoje 54 m², Górna, 365 000 zł", isOffer = true),
        DemoPost("demo-6", "DEMO: Wynajmę pokój studentce, Śródmieście", isOffer = false),
        DemoPost("demo-7", "DEMO: Sprzedam mieszkanie 46 m² w kamienicy, 310 000 zł", isOffer = true),
        DemoPost("demo-8", "DEMO: Kupię mieszkanie za gotówkę, Łódź", isOffer = false),
        DemoPost("demo-9", "DEMO: Sprzedam 2 pokoje 41 m², Retkinia, 315 000 zł", isOffer = true),
        DemoPost("demo-10", "DEMO: Spotkanie grupy w sobotę", isOffer = false),
        DemoPost("demo-11", "DEMO: Sprzedam 1 pokój 31 m², Teofilów, 235 000 zł", isOffer = true),
        DemoPost("demo-12", "DEMO: Ktoś zna dobrego notariusza?", isOffer = false),
    )
}

class DemoScanException(message: String) : RuntimeException(message)

/** Progress inside one group. */
data class GroupProgress(val postsSeen: Int, val offersFound: Int, val totalPosts: Int? = null)

data class GroupScanResult(val postsSeen: Int, val offersFound: Int = 0, val postsSent: Int = 0)

/** One group's work. The live implementation will drive the WebView; this release ships only [DemoScanExecutor]. */
interface ScanExecutor {
    val mode: ScanMode
    suspend fun scanGroup(group: WatchedGroup, onProgress: (GroupProgress) -> Unit): GroupScanResult
}

/**
 * Reads [posts] one by one with a pause between them, so the screen shows a
 * moving counter, and counts the offers among them. [failAfterPosts] makes
 * the scan fail part-way, to exercise the error path. Cancellation (Zatrzymaj)
 * takes effect at the next pause. No network, no Facebook, nothing sent.
 */
class DemoScanExecutor(
    private val posts: List<DemoPost> = DemoData.posts,
    private val pausePerPost: suspend () -> Unit = { delay(350) },
    private val failAfterPosts: Int? = null,
) : ScanExecutor {
    override val mode = ScanMode.DEMO

    override suspend fun scanGroup(group: WatchedGroup, onProgress: (GroupProgress) -> Unit): GroupScanResult {
        var seen = 0
        var offers = 0
        onProgress(GroupProgress(0, 0, posts.size))
        for (post in posts) {
            pausePerPost()
            if (failAfterPosts != null && seen >= failAfterPosts) {
                throw DemoScanException("Symulowany błąd po $seen postach (tryb demo)")
            }
            seen += 1
            if (post.isOffer) offers += 1
            onProgress(GroupProgress(seen, offers, posts.size))
        }
        return GroupScanResult(postsSeen = seen, offersFound = offers, postsSent = 0)
    }
}
