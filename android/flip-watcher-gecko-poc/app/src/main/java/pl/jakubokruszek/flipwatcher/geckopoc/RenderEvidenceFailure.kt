package pl.jakubokruszek.flipwatcher.geckopoc

/** Safe numeric diagnostics survive the final fresh-session failure. */
internal class RenderEvidenceFailure(prefix:String,frames:Int,resets:Int):IllegalStateException("${prefix}_RENDER_RETRY_FAILED") {
    val stats=mapOf(prefix.lowercase()+"RenderedFrames" to frames,prefix.lowercase()+"SurfaceResets" to resets)
}
