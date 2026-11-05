package pl.jakubokruszek.flipwatcher.geckopoc

/** Snapshot of enabled GROUP sources in Watcher, 2026-10-30. Profiles and disabled sources are excluded.
 * Identities are exact: similar names never establish aliases. */
data class WatcherGroup(val id:String,val name:String,val type:String="GROUP") {
    init { require(type in setOf("GROUP","PROFILE"));require(id.matches(Regex("[A-Za-z0-9_.-]{1,100}"))) }
    val key:String get()=if(type=="GROUP")id else "profile:$id"
    val url:String get()=if(type=="GROUP")"https://www.facebook.com/groups/$id/"else if(id.all{it.isDigit()})"https://www.facebook.com/profile.php?id=$id"else"https://www.facebook.com/$id/"
    fun postUrl(post:String)="https://www.facebook.com/"+(if(type=="GROUP")"groups/$id/"else"$id/")+"posts/$post/"
}
object WatcherGroups {
    const val LEGACY_GROUP="lodzsprzedazzakupwynajem"
    val configured=listOf(
        WatcherGroup(LEGACY_GROUP,"Łódź sprzedaż zakup wynajem"),
        WatcherGroup("1253809205540869","FLIPY, FLIPPERZY / INWESTORZY"),
        WatcherGroup("1689328011096404","Kupię/sprzedam mieszkanie w Łodzi"),
        WatcherGroup("1424921570856189","Łódź Nieruchomości — Wynajem / Sprzedaż / Kupno / Zamiana"),
        WatcherGroup("mieszkania.na.sprzedaz.lodz","Mieszkania na sprzedaż Łódź. TYLKO SPRZEDAŻ"),
        WatcherGroup("402796264871862","Nieruchomości Łódź — sprzedam, kupię, wynajmę"),
        WatcherGroup("308185249243000","Bałuty Mieszkańcy"),
        WatcherGroup("441817689512680","Łódź Nieruchomości (kupno, sprzedaż, wynajem)"),
        WatcherGroup("mieszkaniawlodzi","Mieszkania Łódź — Odstępne, Sprzedaż, Wynajem"),
        WatcherGroup("w.lodzkim.dzialka.dom.mieszkanie","Nieruchomości woj. Łódzkie"),
        WatcherGroup("ogloszenia.lodzkie","Ogłoszenia Nieruchomości Łódzkie"),
    )
    @Volatile private var activeSources:List<WatcherGroup>?=null
    val active:List<WatcherGroup> get()=activeSources?:configured
    fun setActive(groups:List<WatcherGroup>){
        require(groups.size<=200&&groups.map{it.id}.toSet().size==groups.size)
        activeSources=groups.toList()
    }
    fun isActive(id:String)=active.any{it.id==id}
    fun find(id:String)=activeSources?.singleOrNull{it.id==id}?:configured.singleOrNull{it.id==id}
    /** The old encrypted file is retained byte-for-byte; other groups cannot replace it. */
    fun archiveFile(groupId:String):String {
        require(find(groupId)!=null)
        return if(groupId==LEGACY_GROUP)"saved-search-v1.bin" else "saved-search-$groupId-v1.bin"
    }
}

object WatcherSources {
    @Volatile var active:List<WatcherGroup> = emptyList();private set
    fun setActive(sources:List<WatcherGroup>){require(sources.size<=200&&sources.map{it.key}.toSet().size==sources.size);active=sources.toList();WatcherGroups.setActive(sources.filter{it.type=="GROUP"})}
    fun find(key:String)=active.singleOrNull{it.key==key}?:WatcherGroups.find(key)
}
