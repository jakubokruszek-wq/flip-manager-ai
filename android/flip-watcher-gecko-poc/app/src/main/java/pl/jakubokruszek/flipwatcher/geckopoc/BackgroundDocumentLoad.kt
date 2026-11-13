package pl.jakubokruszek.flipwatcher.geckopoc

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/** Gecko's unscoped page-stop callback can belong to an aborted blank page or redirect. */
internal class BackgroundDocumentLoad(private val prefix:String) {
    var ready=false;private set
    var reason:String?=null;private set
    fun started(){ready=false}
    fun stopped(success:Boolean){if(success)ready=true}
    fun reject(code:String){if(reason==null)reason=code}
    fun failed(uri:String?,category:Int,code:Int){
        // about:blank is never evidence of a source document. Its teardown must
        // not abort the real source load that follows it.
        if(uri=="about:blank")return
        fun numeric(value:Int)=value.toString().replace("-","NEG_")
        reject("${prefix}_LOAD_ERROR_C${numeric(category)}_E${numeric(code)}")
    }
}

/** One fresh session only; the worker's outer source deadline still applies. */
internal object BackgroundLoadRetry {
    suspend fun run(prefix:String,alive:()->Boolean,progress:(String)->Unit={},pause:suspend ()->Unit={delay(1000)},attempt:suspend ()->SavedResult):SavedResult {
        for(index in 0..1){
            try{
                val value=attempt()
                return value.copy(captureStats=value.captureStats+mapOf(prefix.lowercase()+"LoadAttempts" to index+1))
            }catch(e:Exception){
                if(e is CancellationException)throw e
                val reason=e.message.orEmpty()
                val retryable=reason=="${prefix}_NOT_READY"||reason=="${prefix}_RENDER_RETRY_FAILED"||reason=="${prefix}_LOAD_ERROR"||reason.startsWith("${prefix}_LOAD_ERROR_")
                if(index==1||!retryable||!alive())throw e
                progress("LOADING");pause()
                if(!alive())throw e
            }
        }
        error("UNREACHABLE")
    }
}
