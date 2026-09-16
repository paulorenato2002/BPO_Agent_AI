"""Conferência em três vias. Nomes e valores fictícios; amostras reais só pelo esperado.json local."""
import json
from pathlib import Path

import pytest

from conferencia import conferir_tres, cpf_compativel
from core import Documento, Item, ler_pdf

AMOSTRAS = Path(__file__).parent / "docs_amostra"
VENC = "10/09/2026"


def doc(tipo, itens, periodo=None):
    return Documento(f"{tipo}.pdf", tipo, tipo, 1, itens, total_impresso=sum(i.valor for i in itens),
                     periodo=periodo or [])


def conta(id_, descricao, valor, categoria="Salários", fornecedor="", data=VENC):
    return Item(id_, fornecedor, valor, data, descricao, categoria, situacao="Em aberto")


def folha(id_, nome, valor, cpf=""):
    return Item(id_, nome, valor, documento=cpf)


def banco(id_, nome, valor, cpf="", data=VENC, situacao="Pendente de autorização", descricao=""):
    return Item(id_, nome, valor, data, descricao, documento=cpf, situacao=situacao)


def tipos(r):
    return sorted(d["tipo"] for l in r.linhas for d in l.divergencias)


PERIODO = ["01/09/2026", "30/09/2026"]


def test_folha_e_banco_batem():
    c = doc("contas", [conta("1", "9/12 - SALÁRIO - ANA PAULA SOUZA", 150000)])
    f = doc("folha", [folha("1", "ANA PAULA SOUZA LIMA", 150000, "123.456.789-01")])
    b = doc("itau", [banco("1", "ANA PAULA SOUZA LIMA", 150000, "***.456.789-**")], PERIODO)
    r = conferir_tres(c, b, f)
    assert not r.divergentes
    assert "**Tudo confere.**" in r.markdown()


def test_salario_a_menor_no_contas():
    c = doc("contas", [conta("1", "SALÁRIO - BRUNO COSTA", 80000), conta("2", "Aluguel", 50000, "Aluguel", "IMOBILIARIA X")])
    f = doc("folha", [folha("1", "BRUNO COSTA DIAS", 92000)])
    r = conferir_tres(c, None, f)
    assert tipos(r) == ["valor_folha"]
    assert len(r.linhas) == 1                         # sem banco, só a folha conta
    texto = r.markdown()
    assert "R$ 120,00 a menor" in texto
    assert "passa de **R$ 1.300,00** para **R$ 1.420,00**" in texto


def test_faltou_agendar_e_agendado_sem_conta():
    c = doc("contas", [conta("1", "Serviços prestados", 74490, "Remuneração de Autônomos", "CARLA MENDES")])
    b = doc("itau", [banco("1", "ESCRITORIO BETA", 30000, "11.222.333/0001-44")], PERIODO)
    r = conferir_tres(c, b)
    assert tipos(r) == ["banco_sem_conta", "faltou_agendar"]
    assert any("Agendar **R$ 744,90** para **CARLA MENDES**" in a for a in [x[0].upper() + x[1:] for x in r.acoes])
    assert not any("sem explicação" in t for t in r.explicacao)


def test_desconto_nao_e_divergencia():
    c = doc("contas", [conta("1", "Mercadoria", 100000, "Compras", "DISTRIBUIDORA GAMA")])
    b = doc("itau", [banco("1", "DISTRIBUIDORA GAMA LTDA", 95000)], PERIODO)
    r = conferir_tres(c, b)
    assert not r.divergentes
    assert any("Parece desconto" in p for p in r.pontos)


def test_valor_diferente_sem_padrao_de_desconto():
    c = doc("contas", [conta("1", "Mercadoria", 100000, "Compras", "DISTRIBUIDORA GAMA")])
    b = doc("itau", [banco("1", "DISTRIBUIDORA GAMA LTDA", 91234)], PERIODO)
    assert tipos(conferir_tres(c, b)) == ["valor_banco"]


def test_pensao_vira_ponto_para_confirmar():
    c = doc("contas", [conta("1", "PENSÃO ALIMENTÍCIA - DIEGO ALVES", 45279, "Pensão Alimentícia", "MARTA SOUZA")])
    b = doc("sicoob", [banco("1", "MARTA SOUZA PEREIRA", 45279, data="04/09/2026")])
    r = conferir_tres(c, b)
    assert not r.divergentes
    assert any(p.startswith("**Pensão — R$ 452,79**") and "MARTA SOUZA PEREIRA" in p for p in r.pontos)


def test_socio_recebe_pela_empresa_e_relacao_se_repete():
    c = doc("contas", [conta("1", "8/11 - EDUARDO - DISTRIBUIÇÃO DE LUCROS", 262500, "Distribuição de Lucros", "EMPRESA CLIENTE"),
                       conta("2", "8/11 - EDUARDO - DEVOLUÇÕES DE APORTE", 75000, "Devoluções de Aportes", "EMPRESA CLIENTE"),
                       conta("3", "8/11 - FABIO - DEVOLUÇÕES DE APORTE", 75000, "Devoluções de Aportes", "EMPRESA CLIENTE"),
                       conta("4", "8/11 - FABIO - DISTRIBUIÇÃO DE LUCROS", 175000, "Distribuição de Lucros", "EMPRESA CLIENTE")])
    b = doc("sicoob", [banco("1", "HOLDING DELTA", 262500), banco("2", "HOLDING DELTA", 75000),
                       banco("3", "PARTICIPACOES OMEGA", 75000), banco("4", "PARTICIPACOES OMEGA", 175000)])
    r = conferir_tres(c, b)
    assert not r.divergentes
    pares = {(l.nome_conta.split(" -")[0], l.banco.nome) for l in r.linhas}
    assert pares == {("EDUARDO", "HOLDING DELTA"), ("FABIO", "PARTICIPACOES OMEGA")}


def test_pagamento_conjunto_com_divisao_diferente():
    c = doc("contas", [conta("1", "1/11 - LUCIA / MARCOS - DISTRIBUIÇÃO DE LUCROS", 1925000, "Distribuição de Lucros", "EMPRESA CLIENTE"),
                       conta("2", "1/11 - LUCIA / MARCOS - DEVOLUÇÕES DE APORTE", 1350000, "Devoluções de Aportes", "EMPRESA CLIENTE")])
    b = doc("sicoob", [banco("1", "MARCOS OLIVEIRA", 2000000), banco("2", "LUCIA RAMOS", 1275000)])
    r = conferir_tres(c, b)
    assert not r.divergentes
    assert any("Pagamento conjunto" in p for p in r.pontos)
    assert not any("sem explicação" in t for t in r.explicacao)


def test_valores_iguais_sem_nome_nao_se_casam_por_valor():
    c = doc("contas", [conta("1", "Serviço", 10000, "Serviços", "ALFA SERVICOS"), conta("2", "Serviço", 10000, "Serviços", "BETA SERVICOS")])
    b = doc("itau", [banco("1", "GAMA LTDA", 10000), banco("2", "DELTA LTDA", 10000)], PERIODO)
    assert tipos(conferir_tres(c, b)).count("faltou_agendar") == 2


def test_folha_fora_do_relatorio_do_banco():
    c = doc("contas", [conta("1", "SALÁRIO - HELENA ROCHA", 200000), conta("2", "Energia", 30000, "Energia", "COMPANHIA LUZ")])
    f = doc("folha", [folha("1", "HELENA ROCHA", 200000)])
    b = doc("itau", [banco("1", "COMPANHIA LUZ SA", 30000)], PERIODO)
    r = conferir_tres(c, b, f)
    assert not r.divergentes
    assert not r.banco_cobre_folha
    assert any("não traz nenhum pagamento da folha" in p for p in r.pontos)


def test_debito_automatico_nao_precisa_agendar():
    c = doc("contas", [conta("1", "Telefone", 12499, "Telefone", "OPERADORA (DÉBITO AUTOMÁTICO)")])
    b = doc("itau", [banco("1", "OUTRO FAVORECIDO", 5000)], PERIODO)
    r = conferir_tres(c, b)
    assert "faltou_agendar" not in tipos(r)
    assert any("débito automático" in p for p in r.pontos)


def test_cpf_incompativel_nao_casa():
    assert cpf_compativel("123.456.789-01", "***.456.789-**") is True
    assert cpf_compativel("123.456.789-01", "***.999.789-**") is False
    f = doc("folha", [folha("1", "IGOR NUNES", 100000, "123.456.789-01")])
    c = doc("contas", [conta("1", "SALÁRIO - IGOR NUNES", 100000)])
    b = doc("sicoob", [banco("1", "IGOR NUNES", 100000, "***.999.789-**", data="04/09/2026")])
    assert "faltou_agendar" in tipos(conferir_tres(c, b, f))


def test_conta_fora_do_periodo_do_banco():
    c = doc("contas", [conta("1", "Serviço", 10000, "Serviços", "ALFA SERVICOS", data="02/09/2026")])
    b = doc("itau", [banco("1", "BETA", 5000)], ["05/09/2026", "13/09/2026"])
    r = conferir_tres(c, b)
    assert "faltou_agendar" not in tipos(r)
    assert any("fora do período" in p for p in r.pontos)


def test_exige_banco_ou_folha():
    with pytest.raises(ValueError):
        conferir_tres(doc("contas", []))


@pytest.fixture(scope="module")
def reais():
    arq = AMOSTRAS / "esperado.json"
    if not arq.exists() or len(list(AMOSTRAS.glob("*.pdf"))) != 9:
        pytest.skip("Amostras privadas não instaladas (não versionadas).")
    docs = [ler_pdf(p.name, p.read_bytes()) for p in AMOSTRAS.glob("*.pdf")]
    return docs, json.loads(arq.read_text(encoding="utf-8"))["conferencia"]


def test_amostras_reais(reais):
    docs, esperado = reais
    for grupo, e in esperado.items():
        ds = [d for d in docs if d.arquivo.upper().split("-")[0].strip() == grupo]
        tipo = lambda *t: next(d for d in ds if d.tipo in t)
        r = conferir_tres(tipo("contas"), tipo("itau", "sicoob"), tipo("folha"))
        obtidas = sorted([d["tipo"], d["diferenca"]] for l in r.linhas for d in l.divergencias)
        assert obtidas == sorted(e["divergencias"]), grupo
        assert r.banco_cobre_folha is e["banco_cobre_folha"], grupo
        assert not any("sem explicação" in t for t in r.explicacao), grupo
