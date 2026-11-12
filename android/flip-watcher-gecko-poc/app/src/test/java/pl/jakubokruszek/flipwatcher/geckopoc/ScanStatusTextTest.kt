package pl.jakubokruszek.flipwatcher.geckopoc

import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneId

class ScanStatusTextTest {
    private val now=1_800_000_000_000L
    @Test fun interruptedRecoveryIsPendingAndOnlyKnownStopReasonsAreExplained(){
        assertEquals("Skan częściowy — oczekuje na ponowienie",ScanStatusText.title(ScanState(phase="RETRY",reason="INTERRUPTED"),true,now,false))
        assertTrue(ScanStatusText.reason("INTERRUPTED_NETWORK").contains("połączenia"))
        assertTrue(ScanStatusText.reason("INTERRUPTED_TIMEOUT").contains("limitu czasu"))
        assertTrue(ScanStatusText.reason("INTERRUPTED_QUOTA").contains("limitu pracy"))
        assertFalse(ScanStatusText.reason("INTERRUPTED").contains("Android"))
    }
    @Test fun staleProcessIsNotFalselyReportedAsCompletedOrKilledByAndroid(){
        val state=ScanState(phase="READING",heartbeat=now-120_000,changed=now-120_000)
        assertEquals("Brak potwierdzenia dalszej pracy",ScanStatusText.title(state,true,now,false))
        assertEquals("Zadanie uruchomione — brak świeżego potwierdzenia",ScanStatusText.title(state,true,now,true))
        val text=ScanStatusText.details(state,true,now,now+1000,true,true,"oczekuje",false)
        assertTrue(text.contains("Android nie podał przyczyny"));assertFalse(text.contains("Skan zakończony"))
    }
    @Test fun slowStageShowsHeartbeatSeparatelyFromActualProgress(){
        val state=ScanState(phase="READING",heartbeat=now,changed=now-120_000,total=11,done=3,position=4,group="Grupa testowa",posts=8,photos=5,started=now-130_000)
        val text=ScanStatusText.details(state,true,now,now+1000,true,true,"uruchomione",true,ZoneId.of("Europe/Warsaw"))
        assertTrue(text.contains("Źródła z zakończoną próbą: 3/11"));assertTrue(text.contains("posty 8 • zdjęcia 5"));assertTrue(text.contains("nie oznacza znalezienia nowych postów"));assertFalse(text.contains("%"))
    }
    @Test fun blockedStartHasSpecificReasonAndNoInventedAndroidDiagnosis(){
        val text=ScanStatusText.details(ScanState(phase="QUEUED"),true,now,now+1000,false,false,"zadanie oczekuje",false,pendingWindow=now-60_000)
        assertTrue(text.contains("oczekuje na uruchomienie"));assertTrue(text.contains("oczekuje na dostęp do internetu"));assertTrue(text.contains("Powiadomienia"));assertTrue(text.contains("ukończenie nie zostało potwierdzone"))
        assertTrue(ScanStatusText.reason("LOGIN_REQUIRED").contains("zaloguj"))
        assertTrue(ScanStatusText.reason("WAITING_FOR_BACKGROUND").contains("ekran główny"))
        assertEquals("Automat wyłączony",ScanStatusText.title(ScanState(phase="DONE"),false,now,false))
    }
    @org.junit.Test fun groupTimerUsesGroupStartAndStopsWhenAttemptEnds(){
        val now=1_000_000L
        val s=ScanState(phase="READING",started=now-200_000,heartbeat=now,groupStarted=now-65_000)
        fun text(value:ScanState)=ScanStatusText.details(value,true,now,now+1000,true,true,"",true)
        org.junit.Assert.assertTrue(text(s).contains("Czas bieżącego źródła: 1 min 5 s • trwa"))
        org.junit.Assert.assertTrue(text(s.copy(phase="PARTIAL",ended=now-10_000)).contains("Czas bieżącego źródła: 0 min 55 s • próba zakończona"))
        org.junit.Assert.assertFalse(ScanStatusText.reason("CAPTURE_PARTIAL").contains("nie potwierdziła przewijania"))
    }

}
