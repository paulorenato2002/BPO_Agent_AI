import json
from dataclasses import replace
from pathlib import Path

import pytest

from core import Documento, Item, conferir, ler_pdf

ROOT = Path(__file__).parent
AMOSTRAS = ROOT / "docs_amostra"


@pytest.fixture(scope="module")
def esperado():
    arq = AMOSTRAS / "esperado.json"
    if not arq.exists() or len(list(AMOSTRAS.glob("*.pdf"))) != 9:
        pytest.skip("Amostras privadas não instaladas (não versionadas).")
    return json.loads(arq.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def amostras(esperado):
    return [ler_pdf(p.name, p.read_bytes()) for p in AMOSTRAS.glob("*.pdf")]


def get(ds, grupo, tipo):
    return next(d for d in ds if d.arquivo.upper().split("-")[0].strip() == grupo and d.tipo == tipo)


def test_totais_reais(amostras, esperado):
    for grupo, tipo, n, total in esperado["totais"]:
        d = get(amostras, grupo, tipo)
        assert d.integro, (grupo, tipo, d.alertas)
        assert (len(d.itens), d.total) == (n, total), (grupo, tipo)


def test_divergencia_conhecida_na_folha(amostras, esperado):
    e = esperado["auditoria"]["divergencia_folha"]
    rows = conferir(get(amostras, e["grupo"], "contas"), get(amostras, e["grupo"], "folha"))
    assert any(x["status"] == "Divergência de valor" and x["diferença_centavos"] == e["centavos"] for x in rows)


def test_folha_banco_sicoob(amostras, esperado):
    e = esperado["auditoria"]["folha_banco_revisar_data"]
    rows = conferir(get(amostras, e["grupo"], "folha"), get(amostras, e["grupo"], "sicoob"))
    assert sum(x["status"] == "Revisar data Sicoob" for x in rows) == e["quantidade"]
    assert sum(x["status"] == "Líquido zero" for x in rows) == e["liquido_zero"]


def test_periodo_nao_acusa_ausencia(amostras, esperado):
    e = esperado["auditoria"]["fora_do_periodo"]
    rows = conferir(get(amostras, e["grupo"], "contas"), get(amostras, e["grupo"], "itau"))
    assert sum(x["status"] == "Fora do período" for x in rows) == e["quantidade"]


def test_situacao_sem_numero_vazado(amostras):
    for d in amostras:
        if d.tipo == "contas":
            assert all(not i.situacao[:1].isdigit() for i in d.itens), d.arquivo


def doc(items, tipo="contas"):
    return Documento("teste.pdf", "hash", tipo, 1, items, total_impresso=sum(i.valor for i in items))


def test_total_alterado_bloqueia():
    a = doc([Item("1", "Pessoa Exemplo", 100)])
    a.total_impresso = 101
    assert conferir(a, a)[0]["status"] == "Bloqueado"


def test_valor_igual_nao_identifica():
    rows = conferir(doc([Item("1", "Fornecedor Alfa", 100)]), doc([Item("2", "Empresa Beta", 100)]))
    assert rows[0]["status"] == "Sem correspondência"


def test_duplicidade_nao_concilia_duas_vezes():
    rows = conferir(doc([Item("1", "Pessoa Exemplo", 100), Item("2", "Pessoa Exemplo", 100)]),
                    doc([Item("3", "Pessoa Exemplo", 100)]))
    assert sum(x["status"] == "Ambíguo" for x in rows) == 2
    assert not any(x["status"] == "Correspondência" for x in rows)


def test_cnpj_diferente_bloqueia():
    a = doc([Item("1", "Pessoa Exemplo", 100)])
    b = replace(a, cnpj="outro")
    a.cnpj = "um"
    assert conferir(a, b)[0]["status"] == "Bloqueado"


def test_data_divergente():
    a = doc([Item("1", "Pessoa Exemplo", 100, "04/09/2026")])
    b = doc([Item("2", "Pessoa Exemplo", 100, "10/09/2026")])
    assert conferir(a, b)[0]["status"] == "Divergência de data"


def test_documento_conflitante():
    a = doc([Item("1", "Pessoa Exemplo", 100, documento="123.456.789-00")])
    b = doc([Item("2", "Pessoa Exemplo", 100, documento="***.111.789-**")])
    assert conferir(a, b)[0]["status"] == "Divergência de documento"


def test_relacao_explicita():
    a = doc([Item("1", "Fornecedor Alfa", 100)])
    b = doc([Item("2", "Empresa Beta", 100)])
    assert conferir(a, b, {"Fornecedor Alfa": "Empresa Beta"})[0]["status"] == "Correspondência"


def test_pdf_invalido():
    with pytest.raises(ValueError):
        ler_pdf("falso.pdf", b"not a pdf")


# ------------------------------------------------------------------ filtro rápido do Conta Azul

def _contas_filtradas(valores):
    from core import Documento, Item
    return Documento("contas.pdf", "h", "contas", 1,
                     [Item(str(n), "FORNECEDOR", v) for n, v in enumerate(valores, 1)],
                     total_impresso=sum(valores) + 1234500)


def test_filtro_a_vencer_fecha_pelo_quadro_e_avisa_o_que_ficou_de_fora():
    from core import _conferir_filtro_rapido
    d = _contas_filtradas([5000000])
    baldes = {"Vencidos": 0, "Vencem hoje": 1234500, "A vencer": 5000000, "Pagos": 0}
    _conferir_filtro_rapido(d, baldes, "A vencer")
    assert d.total_impresso == 5000000
    assert d.integro
    assert "vencem hoje R$ 12.345,00" in d.avisos[0] and "NÃO foram conferidas" in d.avisos[0]


def test_filtro_nao_salva_leitura_errada():
    from core import _conferir_filtro_rapido
    d = _contas_filtradas([4999990])            # soma lida não bate com o quadro "A vencer"
    impresso = d.total_impresso
    _conferir_filtro_rapido(d, {"Vencidos": 0, "Vencem hoje": 1234500, "A vencer": 5000000, "Pagos": 0}, "A vencer")
    assert d.total_impresso == impresso and not d.avisos


def test_filtro_desconhecido_nao_muda_nada():
    from core import _conferir_filtro_rapido
    d = _contas_filtradas([5000000])
    impresso = d.total_impresso
    _conferir_filtro_rapido(d, {"Vencidos": 0, "Vencem hoje": 1234500, "A vencer": 5000000, "Pagos": 0}, "Categoria X")
    assert d.total_impresso == impresso and not d.avisos
