#!/usr/bin/env python3
"""Puxa as tarifas vigentes da ANEEL (dados abertos) e regenera
src/data/aneel-tariffs.json — B3 Convencional, "Tarifa de Aplicação".

Fonte: https://dadosabertos.aneel.gov.br · dataset tarifas-distribuidoras-energia-eletrica
Roda semanalmente pelo GitHub Action (.github/workflows/aneel.yml).
"""
import json, urllib.request, urllib.parse, os, datetime, time

RID = "fcf2906c-7c32-4b9b-a637-054e7a5234f4"
BASE = "https://dadosabertos.aneel.gov.br/api/3/action/datastore_search"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src/data/aneel-tariffs.json")
FILTERS = {
    "DscBaseTarifaria": "Tarifa de Aplicação",
    "DscSubGrupo": "B3",
    "DscModalidadeTarifaria": "Convencional",
    "DscDetalhe": "Não se aplica",
    "NomPostoTarifario": "Não se aplica",
}


def num(s):
    if s in (None, ""):
        return 0.0
    try:
        return float(str(s).replace(".", "").replace(",", "."))
    except ValueError:
        return 0.0


def fetch(offset):
    q = urllib.parse.urlencode({"resource_id": RID, "limit": 500, "offset": offset,
                                "filters": json.dumps(FILTERS, ensure_ascii=False)})
    req = urllib.request.Request(f"{BASE}?{q}", headers={"User-Agent": "asset-forecast-demo/1.0"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)["result"]
        except Exception as e:
            if attempt == 4:
                raise
            time.sleep(3 * (attempt + 1))
    return None


def main():
    records = []
    off = 0
    total = None
    while True:
        res = fetch(off)
        total = res["total"]
        records += res["records"]
        off += 500
        time.sleep(1)
        if off >= total:
            break
    print(f"registros B3 Convencional (Tarifa de Aplicação): {len(records)}")

    # por distribuidora, pega a vigência mais recente
    best = {}
    geradoAneel = ""
    for r in records:
        sig = (r.get("SigAgente") or "").strip()
        if not sig:
            continue
        ini = (r.get("DatInicioVigencia") or "")[:10]
        geradoAneel = geradoAneel or (r.get("DatGeracaoConjuntoDados") or "")[:10]
        # chave normalizada (case-insensitive) → funde "CPFL SANTA CRUZ" e "CPFL Santa Cruz",
        # ficando com a vigência mais recente e o nome (case) do registro mais novo.
        k = sig.upper()
        cur = best.get(k)
        if cur is None or ini > cur["vigInicio"]:
            best[k] = {
                "sigAgente": sig,
                "tusd": round(num(r.get("VlrTUSD")), 2),
                "te": round(num(r.get("VlrTE")), 2),
                "resolution": (r.get("DscREH") or "").strip(),
                "vigInicio": ini,
                "vigFim": (r.get("DatFimVigencia") or "")[:10],
                "cnpj": (r.get("NumCNPJDistribuidora") or "").strip() or None,
            }
    dists = sorted(best.values(), key=lambda d: d["sigAgente"])
    out = {
        "fetchedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "geradoAneel": geradoAneel,
        "distribuidoras": dists,
    }
    json.dump(out, open(OUT, "w"), ensure_ascii=False, indent=1)
    print(f"OK: {len(dists)} distribuidoras · geradoAneel {geradoAneel} → {OUT}")


if __name__ == "__main__":
    main()
