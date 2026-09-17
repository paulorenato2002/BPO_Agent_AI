"""Planilhas e listas de VT/VA. Nomes e valores fictícios."""
import io

from openpyxl import Workbook

from fontes import fala_de, ler_planilha, ler_tabela, ler_texto, rotulo_de
from core import Item


def xlsx(linhas, titulo="Plan1"):
    wb = Workbook()
    ws = wb.active
    ws.title = titulo
    for l in linhas:
        ws.append(l)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_planilha_de_vt_com_titulo_total_e_colunas_extras():
    dados = xlsx([
        ["VALE TRANSPORTE - SETEMBRO"],
        [],
        ["Matrícula", "Nome do funcionário", "CPF", "Dias", "Valor diário", "Valor total"],
        [1, "Ana Lima", "123.456.789-01", 22, 10.5, 231],
        [2, "Bruno Reis", "987.654.321-00", 20, 8.25, 165.0],
        [3, "Carla Dias", "", 0, 0, None],
        [None, "TOTAL", None, None, None, 396],
    ])
    [d] = ler_planilha("beneficios.xlsx", dados)
    assert d.rotulo == "VT"
    assert [(i.nome, i.valor) for i in d.itens] == [("Ana Lima", 23100), ("Bruno Reis", 16500)]
    assert d.itens[0].documento == "123.456.789-01"
    assert d.total_impresso == 39600 and d.integro


def test_total_que_nao_fecha_bloqueia():
    [d] = ler_tabela("va.csv", [["Nome", "Valor"], ["Ana", "100,00"], ["Total", "150,00"]])
    assert d.rotulo == "VA" and not d.integro
    assert "não bate" in d.alertas[0]


def test_uma_coluna_por_beneficio_vira_duas_listas():
    docs = ler_tabela("beneficios.csv", [["Colaborador", "VT", "VA"], ["Ana", "100,00", "300,00"],
                                         ["Bruno", "", "300,00"]])
    assert [(d.rotulo, d.total) for d in docs] == [("VT", 10000), ("VA", 60000)]


def test_valor_ilegivel_vira_alerta():
    [d] = ler_tabela("vt.csv", [["Nome", "Valor"], ["Ana", "cem reais"], ["Bruno", "80,00"]])
    assert not d.integro and "ilegível" in d.alertas[0]


def test_sem_coluna_de_nome():
    [d] = ler_tabela("x.csv", [["Data", "Valor"], ["01/09", "10,00"]])
    assert not d.itens and "coluna de nome" in d.alertas[0]


def test_csv_com_ponto_e_virgula():
    [d] = ler_planilha("VA setembro.csv", "Nome;Valor a pagar\nAna Lima;R$ 1.200,50\n".encode("utf-8"))
    assert d.rotulo == "VA" and d.itens[0].valor == 120050


def test_texto_colado_com_secoes():
    docs = ler_texto("mensagem", "VT\nAna Lima - R$ 150,00\nBruno Reis: 180,00\n\nVale alimentação\n"
                                 "Ana Lima 400,00\nTotal 400,00\nlinha solta sem valor")
    assert [(d.rotulo, [(i.nome, i.valor) for i in d.itens]) for d in docs] == [
        ("VT", [("Ana Lima", 15000), ("Bruno Reis", 18000)]),
        ("VA", [("Ana Lima", 40000)]),
    ]
    assert all(d.integro for d in docs)


def test_texto_com_rotulo_na_linha_e_sem_rotulo():
    docs = ler_texto("mensagem", "VT Ana Lima 150,00\nVA Ana Lima 300,00\nFornecedor Beta 99,90")
    assert {(d.rotulo, i.nome, i.valor) for d in docs for i in d.itens} == {
        ("VT", "Ana Lima", 15000), ("VA", "Ana Lima", 30000), ("", "Fornecedor Beta", 9990)}


def test_texto_sem_nada_legivel():
    [d] = ler_texto("mensagem", "oi, segue")
    assert not d.integro


def test_rotulos_e_lancamentos():
    assert rotulo_de("Vale-Transporte") == "VT"
    assert rotulo_de("Vale Refeição") == "VR"
    assert rotulo_de("VT e VA") == ""
    assert fala_de("VT", Item("1", "EMPRESA X", 1, categoria="Vale-transporte"))
    assert fala_de("VA", Item("1", "ALELO", 1, categoria="Benefícios"))
    assert not fala_de("VT", Item("1", "TRANSPORTES RAPIDOS EXEMPLO", 1, categoria="Fretes"))
    assert not fala_de("VT", Item("1", "ALELO", 1, categoria="Vale alimentação"))
