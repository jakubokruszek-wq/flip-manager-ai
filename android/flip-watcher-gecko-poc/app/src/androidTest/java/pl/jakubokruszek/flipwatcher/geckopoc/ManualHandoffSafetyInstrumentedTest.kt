package pl.jakubokruszek.flipwatcher.geckopoc

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class ManualHandoffSafetyInstrumentedTest {
    private val application:Application=ApplicationProvider.getApplicationContext()
    private val main get()=application.applicationInfo.processName
    private fun restore(prefs:SharedPreferences,values:Map<String,*>) {
        val edit=prefs.edit().clear()
        for((key,value)in values)when(value){
            is String->edit.putString(key,value);is Boolean->edit.putBoolean(key,value)
            is Long->edit.putLong(key,value);is Int->edit.putInt(key,value);is Float->edit.putFloat(key,value)
            is Set<*>->edit.putStringSet(key,value.filterIsInstance<String>().toSet())
        }
        check(edit.commit())
    }
    @Test fun childProcessNeverRegistersOrTouchesPreferencesWorkManagerOrHandler(){
        var registers=0;var posts=0;var reads=0;var enqueues=0;var failures=0
        val installed=ManualScanHandoff.install(application,currentProcess={"$main:tab99"},
            register={registers++},post={posts++},preferences={reads++;error("Child preferences must not be opened")},
            enqueue={enqueues++},failure={failures++})
        assertFalse(installed);assertEquals(0,registers);assertEquals(0,posts);assertEquals(0,reads);assertEquals(0,enqueues);assertEquals(0,failures)
    }
    @Test fun unknownProcessIdentityFailsClosedWithoutSideEffects(){
        var touches=0
        for(identity in listOf<String?>(null,"")){
            assertFalse(ManualScanHandoff.install(application,currentProcess={identity},register={touches++},post={touches++},
                preferences={touches++;error("No identity")},enqueue={touches++},failure={touches++}))
        }
        assertFalse(ManualScanHandoff.install(application,currentProcess={throw SecurityException("No process access")},register={touches++},post={touches++},
            preferences={touches++;error("No identity")},enqueue={touches++},failure={touches++}))
        assertEquals(0,touches)
    }
    @Test fun enqueueFailureOnActualMainThreadIsContainedAndPendingRequestSurvives(){
        val prefs=application.getSharedPreferences("handoff-fixture-"+UUID.randomUUID(),Context.MODE_PRIVATE)
        val journal=application.getSharedPreferences("watcher-manual-handoff-diagnostics-v1",Context.MODE_PRIVATE);val backup=journal.all.toMap()
        val request=UUID.randomUUID().toString();val jobs=mutableListOf<()->Unit>();var enqueues=0
        try {
            journal.edit().clear().commit();prefs.edit().putString("requested_scan",request).putString(ManualScanHandoff.KEY,request).commit()
            assertTrue(ManualScanHandoff.install(application,currentProcess={main},register={},post={jobs.add(it);Unit},preferences={prefs},
                visible={false},enqueue={enqueues++;throw IllegalStateException("PRIVATE_MESSAGE_NOT_TO_STORE")}))
            assertEquals(1,jobs.size)
            InstrumentationRegistry.getInstrumentation().runOnMainSync{jobs.removeAt(0).invoke()}
            assertEquals(1,enqueues);assertEquals(request,prefs.getString("requested_scan",null));assertEquals(request,prefs.getString(ManualScanHandoff.KEY,null))
            assertEquals(1,ManualScanHandoff.failureCounts(application)["manualKickFailureType"])
            assertEquals(1,ManualScanHandoff.failureCounts(application)["manualKickFailureCount"])
            assertEquals(setOf("lastFailureType","failureCount"),journal.all.keys)
            assertFalse(journal.all.values.any{it is String})
        }finally{prefs.edit().clear().commit();restore(journal,backup)}
    }
    @Test fun preferenceFailureOnActualMainThreadIsContainedWithoutQueueAdmission(){
        val journal=application.getSharedPreferences("watcher-manual-handoff-diagnostics-v1",Context.MODE_PRIVATE);val backup=journal.all.toMap()
        val jobs=mutableListOf<()->Unit>();var enqueues=0
        try {
            journal.edit().clear().commit()
            assertTrue(ManualScanHandoff.install(application,currentProcess={main},register={},post={jobs.add(it);Unit},
                preferences={throw SecurityException("Private preference storage unavailable")},visible={false},enqueue={enqueues++}))
            InstrumentationRegistry.getInstrumentation().runOnMainSync{jobs.removeAt(0).invoke()}
            assertEquals(0,enqueues);assertEquals(2,ManualScanHandoff.failureCounts(application)["manualKickFailureType"])
        }finally{restore(journal,backup)}
    }
    @Test fun normalMainProcessBackgroundEventStillEnqueuesWithoutChangingPendingIdentity(){
        val prefs=application.getSharedPreferences("handoff-fixture-"+UUID.randomUUID(),Context.MODE_PRIVATE)
        val jobs=mutableListOf<()->Unit>();var callbacks:Application.ActivityLifecycleCallbacks?=null;var enqueues=0;var failed=0
        val request=UUID.randomUUID().toString();var visible=true
        try {
            prefs.edit().putString("requested_scan",request).putString(ManualScanHandoff.KEY,request).commit()
            assertTrue(ManualScanHandoff.install(application,currentProcess={main},register={callbacks=it},post={jobs.add(it);Unit},preferences={prefs},
                visible={visible},enqueue={enqueues++},failure={failed++}))
            InstrumentationRegistry.getInstrumentation().runOnMainSync{jobs.removeAt(0).invoke()}
            assertEquals(0,enqueues)
            visible=false
            InstrumentationRegistry.getInstrumentation().runOnMainSync{checkNotNull(callbacks).onActivityStopped(Activity())}
            InstrumentationRegistry.getInstrumentation().runOnMainSync{jobs.removeAt(0).invoke()}
            assertEquals(1,enqueues);assertEquals(0,failed);assertEquals(request,prefs.getString("requested_scan",null));assertEquals(request,prefs.getString(ManualScanHandoff.KEY,null))
        }finally{prefs.edit().clear().commit()}
    }
}
