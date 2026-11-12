package pl.jakubokruszek.flipwatcher.geckopoc

/** Attempted sources are distinct from sources closed after their bounded retry. */
internal data class ScanSourceProgress(val attempted:Int,val closed:Int,val retrying:Int) {
    companion object {
        fun count(active:Set<String>,closed:Set<String>,reported:Set<String>):ScanSourceProgress {
            val finished=closed.intersect(active)
            val attempted=(reported+finished).intersect(active)
            return ScanSourceProgress(attempted.size,finished.size,(attempted-finished).size)
        }
    }
}
