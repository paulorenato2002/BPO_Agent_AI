"""Conferência em três vias. Nomes e valores fictícios; amostras reais só pelo esperado.json local."""
import json
from pathlib import Path

import pytest

from conferencia import conferir_tres, cpf_compativel
from core import Documento, Item, ler_pdf

AMOSTRAS = Path(__file__).parent / "docs_amostra"
VENC = "05/09/2026"  # dia de folha: 28 ao 08


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
    c = doc("contas", [conta("1", "SALÁRIO - BRUNO COSTA", 83000), conta("2", "Aluguel", 50000, "Aluguel", "IMOBILIARIA X")])
    f = doc("folha", [folha("1", "BRUNO COSTA DIAS", 95000)])
    r = conferir_tres(c, None, f)
    assert tipos(r) == ["valor_folha"]
    assert len(r.linhas) == 1                         # sem banco, só a folha conta
    texto = r.markdown()
    assert "R$ 120,00 a menor" in texto
    assert "passa de **R$ 1.330,00** para **R$ 1.450,00**" in texto


def test_faltou_agendar_e_agendado_sem_conta():
    c = doc("contas", [conta("1", "Serviços prestados", 61230, "Remuneração de Autônomos", "CARLA MENDES")])
    b = doc("itau", [banco("1", "ESCRITORIO BETA", 30000, "11.222.333/0001-44")], PERIODO)
    r = conferir_tres(c, b)
    assert tipos(r) == ["banco_sem_conta", "faltou_agendar"]
    assert any("Agendar **R$ 612,30** para **CARLA MENDES**" in a for a in [x[0].upper() + x[1:] for x in r.acoes])
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
    c = doc("contas", [conta("1", "PENSÃO ALIMENTÍCIA - DIEGO ALVES", 41234, "Pensão Alimentícia", "MARTA SOUZA")])
    b = doc("sicoob", [banco("1", "MARTA SOUZA PEREIRA", 41234, data="04/09/2026")])
    r = conferir_tres(c, b)
    assert not r.divergentes
    assert any(p.startswith("**Pensão — R$ 412,34**") and "MARTA SOUZA PEREIRA" in p for p in r.pontos)


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


# ------------------------------------------------------------------ descrição, datas e observações

def test_boleto_sem_favorecido_casa_pela_descricao():
    c = doc("contas", [conta("1", "9/12 - ÁGUA E ENERGIA ELÉTRICA", 543210, "Energia", "IMOBILIARIA SOL")])
    b = doc("sicoob", [banco("1", "", 543210, data="04/09/2026", descricao="ÁGUA E ENERGIA ELÉTRICA")])
    r = conferir_tres(c, b)
    assert not r.divergentes
    assert not any("só pelo valor" in p for p in r.pontos)


def test_descricao_parecida_com_valor_diferente_nao_casa():
    c = doc("contas", [conta("1", "MANUTENÇÃO PREVENTIVA SEMANAL", 120000, "Manutenção", "OFICINA ALFA")])
    b = doc("sicoob", [banco("1", "", 99000, descricao="MANUTENCAO PREVENTIVA")])
    assert tipos(conferir_tres(c, b)) == ["banco_sem_conta", "faltou_agendar"]


def test_data_do_sicoob_e_a_data_do_agendamento():
    c = doc("contas", [conta("1", "Serviço", 50000, "Serviços", "ALFA SERVICOS", data="10/09/2026")])
    depois = doc("sicoob", [banco("1", "ALFA SERVICOS", 50000, data="12/09/2026")])
    antes = doc("sicoob", [banco("1", "ALFA SERVICOS", 50000, data="04/09/2026")])
    assert tipos(conferir_tres(c, depois)) == ["data"]
    assert not conferir_tres(c, antes).divergentes


def test_associacao_por_valor_aceita_agendamento_antecipado():
    c = doc("contas", [conta("1", "Consultoria", 123456, "Serviços", "EMPRESA ALFA", data="10/09/2026")])
    b = doc("sicoob", [banco("1", "", 123456, data="20/08/2026", descricao="HONORARIOS")])
    r = conferir_tres(c, b)
    assert not r.divergentes
    assert any("só pelo valor" in p for p in r.pontos)
    longe = doc("sicoob", [banco("1", "", 123456, data="01/07/2026", descricao="HONORARIOS")])
    assert tipos(conferir_tres(c, longe)) == ["banco_sem_conta", "faltou_agendar"]


def test_observacao_de_folha_em_apuracao():
    c = doc("contas", [conta("1", "SALÁRIO - HELENA ROCHA", 200000), conta("2", "SALÁRIO - IVO MATOS", 150000),
                       conta("3", "Energia", 30000, "Energia", "COMPANHIA LUZ")])
    b = doc("itau", [banco("1", "HELENA ROCHA", 200000), banco("2", "COMPANHIA LUZ SA", 30000)], PERIODO)
    sem_obs = conferir_tres(c, b)
    assert tipos(sem_obs) == ["faltou_agendar"]
    r = conferir_tres(c, b, observacoes="* A folha de pagamento encontra-se em apuração.")
    assert not r.divergentes and r.folha_em_apuracao
    assert "1 lançamento(s) de folha sem agendamento" in r.observacoes[0]["efeito"]


def test_observacao_justifica_favorecido_nao_agendado():
    c = doc("contas", [conta("1", "Agenciamento", 30000, "Serviços", "AGENCIA ESTAGIOS ZETA"),
                       conta("2", "Energia", 30000, "Energia", "COMPANHIA LUZ", data="12/09/2026")])
    b = doc("itau", [banco("1", "COMPANHIA LUZ SA", 30000, data="12/09/2026")], PERIODO)
    r = conferir_tres(c, b, observacoes="Zeta — boleto ainda não recebido/gerado.")
    assert not r.divergentes
    assert r.observacoes[0]["efeito"].startswith("justifica AGENCIA ESTAGIOS ZETA")
    assert any("justificado pela sua observação" in p for p in r.pontos)


def test_observacao_desmentida_pelo_banco_e_sem_relacao():
    c = doc("contas", [conta("1", "Agenciamento", 30000, "Serviços", "AGENCIA ZETA")])
    b = doc("itau", [banco("1", "AGENCIA ZETA LTDA", 30000)], PERIODO)
    r = conferir_tres(c, b, observacoes="Zeta: boleto ainda não recebido\nCliente viaja semana que vem")
    assert "atenção" in r.observacoes[0]["efeito"]
    assert r.observacoes[1]["efeito"] == "não citou nenhum lançamento; vai só na mensagem"
    assert "### Suas observações" in r.markdown()


# ------------------------------------------------------------------ janela da folha, categorias e listas

QUINZENA = ["11/09/2026", "20/09/2026"]


def test_folha_fora_da_janela_nao_entra_e_encargo_nao_e_folha():
    c = doc("contas", [conta("1", "6/9 - INSS", 76543, "INSS sobre Salários - GPS", data="18/09/2026"),
                       conta("2", "ALUGUEL", 26500, "Aluguel", "IMOVEIS SOL", data="18/09/2026")], QUINZENA)
    f = doc("folha", [folha("1", "ANA PAULA SOUZA LIMA", 150000, "123.456.789-01")])
    b = doc("itau", [banco("1", "RECEITA FED-DARF NUMERADO-CB", 76543, data="18/09/2026"),
                     banco("2", "IMOVEIS SOL LTDA", 26500, data="18/09/2026")], ["11/09/2026", "11/10/2026"])
    r = conferir_tres(c, b, f)
    assert not r.divergentes
    assert not r.tem_folha and r.folha_fora_do_periodo
    assert "O extrato da folha não entrou" in r.pontos[0]
    assert not any("não traz nenhum pagamento da folha" in p for p in r.pontos)
    assert not any(l.de_folha for l in r.linhas)


def test_salario_em_dia_de_folha_continua_conferido():
    c = doc("contas", [conta("1", "SALÁRIO - ANA PAULA SOUZA", 150000, data="30/09/2026")],
            ["25/09/2026", "05/10/2026"])
    f = doc("folha", [folha("1", "ANA PAULA SOUZA LIMA", 160000)])
    r = conferir_tres(c, None, f)
    assert tipos(r) == ["valor_folha"]


def test_categoria_indica_o_favorecido_e_troca_o_par_errado():
    """FGTS com fornecedor Receita é pago à Caixa; o INSS vai para o DARF."""
    c = doc("contas", [conta("1", "6/9 - FGTS", 104321, "FGTS e Multa de FGTS", "RECEITA FEDERAL", "18/09/2026"),
                       conta("2", "6/9 - INSS", 76543, "INSS sobre Salários - GPS", data="18/09/2026")], QUINZENA)
    b = doc("itau", [banco("1", "RECEITA FED-DARF NUMERADO-CB", 76543, data="18/09/2026"),
                     banco("2", "CAIXA ECONOMICA FEDERAL", 104321, data="18/09/2026")], QUINZENA)
    r = conferir_tres(c, b)
    assert not r.divergentes
    pares = {l.conta.id: l.banco.id for l in r.linhas if l.conta}
    assert pares == {"1": "2", "2": "1"}
    assert not any("só pelo valor" in p for p in r.pontos)


def test_troca_de_complementos_sem_dica_de_categoria():
    c = doc("contas", [conta("1", "Serviço A", 10000, "Serviços", "GAMA COMERCIO", "15/09/2026"),
                       conta("2", "Serviço B", 7000, "Serviços", "", "15/09/2026")], QUINZENA)
    b = doc("itau", [banco("1", "GAMA COMERCIO E SERVICOS", 7000, data="15/09/2026"),
                     banco("2", "DELTA PAGAMENTOS", 10000, data="15/09/2026")], QUINZENA)
    r = conferir_tres(c, b)
    assert not r.divergentes
    assert sum("só pelo valor" in p for p in r.pontos) >= 1


def test_pago_no_banco_sem_conta_em_aberto_vira_ponto():
    c = doc("contas", [conta("1", "Aluguel", 26500, "Aluguel", "IMOVEIS SOL", "15/09/2026")], QUINZENA)
    b = doc("itau", [banco("1", "IMOVEIS SOL", 26500, data="15/09/2026"),
                     banco("2", "LOJA OMEGA", 310000, data="11/09/2026", situacao="Efetuado")], QUINZENA)
    r = conferir_tres(c, b)
    assert not r.divergentes
    assert any("Já pagos no banco" in p and "LOJA OMEGA" in p for p in r.pontos)
    assert not any("sem explicação" in t for t in r.explicacao)
    assert r.markdown().startswith("**Tudo confere.** O pagamento bate entre o contas a pagar e os agendamentos.")


def lista(rotulo, itens):
    return Documento(f"{rotulo}.xlsx", rotulo, "lista", 1,
                     [Item(str(n), nome, valor, descricao=rotulo) for n, (nome, valor) in enumerate(itens, 1)],
                     total_impresso=sum(v for _, v in itens), rotulo=rotulo)


def test_vt_pessoa_a_pessoa():
    c = doc("contas", [conta("1", "VT - ANA LIMA", 15000, "Vale-transporte", "EMPRESA X", "05/09/2026"),
                       conta("2", "VT - BRUNO REIS", 18000, "Vale-transporte", "EMPRESA X", "05/09/2026"),
                       conta("3", "Aluguel", 26500, "Aluguel", "IMOVEIS SOL", "05/09/2026")])
    vt = lista("VT", [("Ana Lima", 15000), ("Bruno Reis", 20000), ("Carla Dias", 9000)])
    r = conferir_tres(c, listas=[vt])
    assert sorted(d["tipo"] for l in r.divergentes for d in l.divergencias) == ["lista_sem_conta", "valor_lista"]
    assert r.listas[0]["modo"] == "pessoa" and r.listas[0]["conferem"] == 1
    assert all(l.conta is None or l.conta.id != "3" for l in r.linhas)   # sem banco, aluguel não entra
    md = r.markdown()
    assert "Planilha/lista" in md and "a planilha de VT" in md and "### Planilhas e listas" in md


def test_va_pelo_total_da_operadora():
    c = doc("contas", [conta("1", "Recarga setembro", 70000, "Benefícios", "ALELO", "05/09/2026")])
    va = lista("VA", [("Ana Lima", 40000), ("Bruno Reis", 40000)])
    r = conferir_tres(c, listas=[va])
    [l] = r.divergentes
    assert l.divergencias[0]["tipo"] == "total_lista" and l.divergencias[0]["diferenca"] == 10000
    assert r.listas[0]["modo"] == "total"
    ok = conferir_tres(c, listas=[lista("VA", [("Ana Lima", 40000), ("Bruno Reis", 30000)])])
    assert not ok.divergentes and "Confere." in ok.markdown()


def test_lista_sem_lancamento_no_contas():
    c = doc("contas", [conta("1", "Aluguel", 26500, "Aluguel", "IMOVEIS SOL", "05/09/2026")])
    b = doc("itau", [banco("1", "IMOVEIS SOL", 26500, data="05/09/2026")])
    r = conferir_tres(c, b, listas=[lista("VT", [("Ana Lima", 15000)])])
    [l] = r.divergentes
    assert l.divergencias[0]["tipo"] == "lista_sem_conta" and l.soma_contas is None


def test_lista_sem_rotulo_confere_com_todas_as_contas():
    c = doc("contas", [conta("1", "Consultoria", 50000, "Serviços", "EMPRESA ALFA", "15/09/2026")])
    avulsa = lista("", [("Empresa Alfa", 50000), ("Fornecedor Beta", 9990)])
    r = conferir_tres(c, listas=[avulsa])
    assert [d["tipo"] for l in r.divergentes for d in l.divergencias] == ["lista_sem_conta"]
    assert "a lista enviada" in r.markdown()


def novos():
    pasta = AMOSTRAS / "novos"
    arq = pasta / "esperado.json"
    if not arq.exists():
        pytest.skip("Amostras privadas não instaladas (não versionadas).")
    return pasta, json.loads(arq.read_text(encoding="utf-8"))


def test_amostras_novas():
    pasta, esperado = novos()
    for caso in esperado:
        ds = {}
        for nome in caso["arquivos"]:
            d = ler_pdf(nome, (pasta / nome).read_bytes())
            ds[d.tipo] = d
        r = conferir_tres(ds["contas"], ds.get("itau") or ds.get("sicoob"), ds.get("folha"))
        obtidas = sorted([d["tipo"], d["diferenca"]] for l in r.linhas for d in l.divergencias)
        assert obtidas == sorted(caso["divergencias"]), caso["nome"]
        assert sum(l.ja_pago for l in r.linhas) == caso["ja_pagos"], caso["nome"]
        assert not any("sem explicação" in t for t in r.explicacao), caso["nome"]
