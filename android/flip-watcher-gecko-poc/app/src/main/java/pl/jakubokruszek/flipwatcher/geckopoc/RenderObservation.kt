package pl.jakubokruszek.flipwatcher.geckopoc

/** Passive counters. They never authorize a read, recover a session or change a deadline. */
internal class RenderObservation(private val prefix:String,private val now:()->Long){
    @Volatile private var callbacks=0
    @Volatile private var frames=0
    @Volatile private var errors=0
    @Volatile private var errorCode=0
    @Volatile private var composites=0
    @Volatile private var paints=0
    @Volatile private var crashes=0
    @Volatile private var kills=0
    @Volatile private var lastFrame=0L
    private fun inc(n:Int)=(n+1).coerceAtMost(100_000_000)
    fun available(){callbacks=inc(callbacks)}
    fun acquired(){frames=inc(frames);lastFrame=now()}
    fun acquisitionFailed(code:Int){errors=inc(errors);errorCode=code.coerceIn(1,4)}
    fun composite(){composites=inc(composites)}
    fun paint(){paints=inc(paints)}
    fun crash(){crashes=inc(crashes)}
    fun kill(){kills=inc(kills)}
    fun snapshot():Map<String,Int>{val p=prefix.lowercase();return mapOf(
        p+"ImageCallbacks" to callbacks,p+"AcquiredFrames" to frames,p+"AcquireErrors" to errors,p+"AcquireErrorCode" to errorCode,
        p+"CompositeCallbacks" to composites,p+"PaintCallbacks" to paints,p+"ContentCrashes" to crashes,p+"ContentKills" to kills,
        p+"LastFrameAgeMs" to if(lastFrame==0L)0 else (now()-lastFrame).coerceIn(0,100_000_000).toInt())}
}
internal class RenderObservationFailure(code:String,val stats:Map<String,Int>,cause:Exception):IllegalStateException(code,cause)

internal object RenderObservationPolicy {
    const val DURATION=30*60*1000L
    fun active(until:Long,now:Long)=until>now&&until-now<=DURATION
}
