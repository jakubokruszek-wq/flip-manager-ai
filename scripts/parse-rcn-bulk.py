"""Stream official native RCN GML ZIPs into minimal private intermediate rows.
Enum codes: Polish EGiB regulation, DU2024/219 annex9 (1=free market,
1/2=primary/secondary, residential function1). No totals/parties/notaries.
Intermediate unit identifiers must NEVER be published; snapshot builder removes them.
"""
import argparse, json, sys, zipfile, xml.etree.ElementTree as ET
GML='{http://www.opengis.net/gml/3.2}'
XL='{http://www.w3.org/1999/xlink}'
NS='{urn:gugik:specyfikacje:gmlas:rejestrcennieruchomosci:1.0}'
def text(e,key): return (e.findtext(NS+key) or '').strip()
def refs(e,key): return [c.get(XL+'href','').lstrip('#') for c in e.findall(NS+key)]
def one(mapping,keys): return mapping.get(keys[0],{}) if len(keys)==1 else {}
def parse_zip(path):
    tables={k:{} for k in ['RCN_Transakcja','RCN_Nieruchomosc','RCN_Dokument','RCN_Lokal','RCN_Adres']}
    with zipfile.ZipFile(path) as z:
        members=[m for m in z.infolist() if m.filename.lower().endswith('.gml')]
        if len(members)!=1 or members[0].file_size>400_000_000: raise ValueError('Invalid RCN archive')
        with z.open(members[0]) as f:
            # ElementTree does not resolve external entities; explicitly reject DTD as well.
            head=f.read(8192)
            if b'<!DOCTYPE' in head or b'<!ENTITY' in head: raise ValueError('DTD forbidden')
        with z.open(members[0]) as f:
            for _,member in ET.iterparse(f,events=['end']):
                if member.tag.split('}')[-1] not in ['featureMember','member']:continue
                for e in member:
                    kind=e.tag.split('}')[-1]
                    if kind not in tables:continue
                    oid=e.get(GML+'id')
                    if not oid:raise ValueError('Missing GML ID')
                    if kind=='RCN_Transakcja':
                        ident=e.find(NS+'IdRCN/'+NS+'RCN_IdentyfikatorIIP')
                        d={'id':text(ident,'lokalnyId') if ident is not None else '', 'version':text(ident,'wersjaId') if ident is not None else '', 'market':text(e,'rodzajRynku'),'type':text(e,'rodzajTransakcji'),'document':refs(e,'podstawaPrawna'),'properties':refs(e,'nieruchomosc')}
                    elif kind=='RCN_Nieruchomosc':d={'units':refs(e,'lokal'),'share':text(e,'udzialWPrawieDoNieruchomosci'),'description':text(e,'opis')+' '+text(e,'dodatkoweInformacje'),'kind':text(e,'rodzajNieruchomosci')}
                    elif kind=='RCN_Dokument':d={'date':text(e,'dataSporzadzeniaDokumentu')}
                    elif kind=='RCN_Adres':d={'city':text(e,'miejscowosc'),'street':text(e,'ulica'),'number':text(e,'numerPorzadkowy')}
                    else:
                        d={'id':text(e,'idLokalu'),'function':text(e,'funkcjaLokalu'),'area':text(e,'powUzytkowaLokalu'),'price':text(e,'cenaLokaluBrutto'),'description':text(e,'dodatkoweInformacje'),'address':refs(e,'adresBudynkuZLokalem')}
                        point=e.find(NS+'georeferencja/'+GML+'Point')
                        if point is not None and point.get('srsName') in ['urn:ogc:def:crs:EPSG::2177','EPSG:2177']:
                            pos=(point.findtext(GML+'pos') or '').split()
                            if len(pos)==2:d.update(northing=pos[0],easting=pos[1])
                    if oid in tables[kind] and tables[kind][oid]!=d:raise ValueError('Conflicting GML ID')
                    tables[kind][oid]=d
                member.clear()
    out=[]
    for tx in tables['RCN_Transakcja'].values():
        doc=one(tables['RCN_Dokument'],tx['document'])
        properties=[tables['RCN_Nieruchomosc'].get(k) for k in tx['properties']]
        bundle=not properties or any(p is None or not p['units'] or p['kind']!='4' for p in properties)
        for p in properties:
            if p is None:continue
            for ref in p['units']:
                unit=tables['RCN_Lokal'].get(ref)
                if not unit:bundle=True;continue
                addr=one(tables['RCN_Adres'],unit['address'])
                row={'TRAN_LOKALNY_ID_IIP':tx['id'],'TRAN_WERSJA_ID':tx['version'],'TRAN_RODZAJ_TRANS':'wolnyRynek' if tx['type']=='1' else 'unknown:'+tx['type'], 'TRAN_RODZAJ_RYNKU':{'1':'rynekPierwotny','2':'rynekWtorny'}.get(tx['market'],'unknown'), 'DOK_DATA':doc.get('date',''),'LOK_ID_LOKALU':unit['id'],'NIER_UDZIAL':p['share'],'NIER_OPIS':p['description'],'LOK_INFO':unit['description'],'LOK_FUNKCJA':'mieszkalna' if unit['function']=='1' else 'unknown:'+unit['function'],'LOK_POW_UZYT':unit['area'],'LOK_CENA_BRUTTO':unit['price'],'LOK_ADRES':f"MSC:{addr.get('city','')};UL:{addr.get('street','')};NR_PORZ:{addr.get('number','')}"}
                if 'easting' in unit:row.update(_easting=unit['easting'],_northing=unit['northing'])
                out.append((row,tx['id']))
        # Fail closed for a missing/bundled property anywhere in the transaction.
        if bundle:
            for row,tid in reversed(out):
                if tid!=tx['id']:break
                row['NIER_OPIS']='pakiet; '+row['NIER_OPIS']
    return [r for r,_ in out]
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('archives',nargs='+');p.add_argument('--output',required=True);a=p.parse_args()
    rows=[]
    for path in a.archives:
        parsed=parse_zip(path);rows.extend(parsed);print(f'{path}: {len(parsed)} unit observations',file=sys.stderr)
    with open(a.output,'w') as f:json.dump(rows,f,ensure_ascii=False,separators=(',',':'))
