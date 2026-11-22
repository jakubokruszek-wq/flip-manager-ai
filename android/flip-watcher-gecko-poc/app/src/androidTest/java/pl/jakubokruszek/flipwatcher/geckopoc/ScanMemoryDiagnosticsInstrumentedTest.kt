package pl.jakubokruszek.flipwatcher.geckopoc

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScanMemoryDiagnosticsInstrumentedTest {
    @Test fun boundedLocalSamplesRetainLatestMeasurementsWithoutChangingAutomation() {
        val context=ApplicationProvider.getApplicationContext<Context>()
        val prefs=context.getSharedPreferences("watcher-memory-observations-v1",Context.MODE_PRIVATE)
        val automation=WatcherAutomation.preferences(context)
        val before=automation.all.toMap()
        try {
            prefs.edit().clear().commit()
            repeat(30){i->ScanMemoryDiagnostics.record(context,i%2==1){ScanMemoryDiagnostics.Sample(i.toLong(),1024L*i,2048,3072,4096,i==29)}}
            val samples=JSONArray(prefs.getString("samples",null))
            assertEquals(12,samples.length())
            assertEquals(18L,samples.getJSONObject(0).getLong("time"))
            assertEquals(29L,samples.getJSONObject(11).getLong("time"))
            assertTrue(samples.getJSONObject(11).getBoolean("after"))
            assertEquals(setOf("time","after","pss","heap","native","available","low"),samples.getJSONObject(11).keys().asSequence().toSet())
            val rendered=ScanMemoryDiagnostics.text(context)
            assertTrue(rendered.contains("PSS 29 MiB"))
            assertTrue(rendered.contains("mało pamięci: tak"))
            assertEquals(before,automation.all)
        }finally{prefs.edit().clear().commit()}
    }
    @Test fun unavailableMeasurementIsContainedAndDoesNotReplacePriorObservation() {
        val context=ApplicationProvider.getApplicationContext<Context>()
        val prefs=context.getSharedPreferences("watcher-memory-observations-v1",Context.MODE_PRIVATE)
        try {
            prefs.edit().clear().commit()
            ScanMemoryDiagnostics.record(context,false){ScanMemoryDiagnostics.Sample(1,2048,0,0,0,false)}
            val saved=prefs.getString("samples",null)
            ScanMemoryDiagnostics.record(context,true){throw SecurityException("injected")}
            assertEquals(saved,prefs.getString("samples",null))
            assertFalse(ScanMemoryDiagnostics.text(context).contains("injected"))
        }finally{prefs.edit().clear().commit()}
    }
}
