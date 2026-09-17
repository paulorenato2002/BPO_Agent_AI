from datetime import datetime

from conferencia import conferir_tres
from core import Documento, Item
from mensagem import empresa_do_arquivo, mensagem_whatsapp, pendencias_antes_de_enviar, saudacao


def doc(tipo, itens, periodo=None):
    return Documento(f"{tipo}.pdf", tipo, tipo, 1, itens, total_impresso=sum(i.valor for i in itens), periodo=periodo or [])


CONTAS = doc("contas", [Item("1", "COMPANHIA LUZ", 30000, "10/09/2026", "Energia", "Energia", situacao="Em aberto"),
                        Item("2", "AGENCIA ZETA", 30000, "11/09/2026", "Agenciamento", "Serviços", situacao="Em aberto")],
             ["04/09/2026", "13/09/2026"])
BANCO = doc("itau", [Item("1", "COMPANHIA LUZ SA", 30000, "10/09/2026", situacao="Pendente de autorização")],
            ["04/09/2026", "13/09/2026"])
MANHA = datetime(2026, 9, 16, 9)


def test_modelo_com_observacoes_formatado_para_whatsapp():
    r = conferir_tres(CONTAS, BANCO, observacoes="* A folha de pagamento encontra-se em apuração.\n"
                                                 "* Zeta — boleto ainda não recebido/gerado.")
    assert mensagem_whatsapp(r, "Fulano", MANHA, empresa="abc") == (
        "Bom dia, @Fulano!\n"
        "\n"
        "*ABC | Contas a pagar de 04/09 a 13/09*\n"
        "\n"
        "Os lançamentos do período estão agendados no banco, *aguardando sua autorização*, "
        "com as observações abaixo.\n"
        "\n"
        "*Observações:*\n"
        "- A folha de pagamento encontra-se em apuração.\n"
        "- Zeta — boleto ainda não recebido/gerado.\n"
        "\n"
        "Segue abaixo a relação dos agendamentos para sua conferência.\n"
        "Fico à disposição para qualquer ajuste!\n")
    assert pendencias_antes_de_enviar(r) == []


def test_sem_observacoes_nao_repete_e_nao_deixa_bloco_vazio():
    r = conferir_tres(CONTAS, BANCO)
    texto = mensagem_whatsapp(r, "", datetime(2026, 9, 16, 15))
    assert texto.startswith("Boa tarde, @cliente!\n\n*Contas a pagar de 04/09 a 13/09*\n\n")
    assert "Observações" not in texto
    assert "\n\n\n" not in texto
    # Uma frase só sobre os agendamentos, sem "todos os lançamentos encontram-se agendados" repetido.
    assert texto.count("agendados") == 1
    assert pendencias_antes_de_enviar(r) == ["AGENCIA ZETA: Faltou agendar"]


def test_so_arroba_fica_para_marcar_no_whatsapp():
    r = conferir_tres(CONTAS, BANCO)
    assert mensagem_whatsapp(r, "@", MANHA).startswith("Bom dia, @\n\n")


def test_saudacao_e_banco_efetuado():
    assert [saudacao(datetime(2026, 1, 1, h)) for h in (8, 13, 20)] == ["Bom dia", "Boa tarde", "Boa noite"]
    efetuado = doc("itau", [Item("1", "COMPANHIA LUZ SA", 30000, "10/09/2026", situacao="Efetuado")], ["04/09/2026", "13/09/2026"])
    r = conferir_tres(doc("contas", CONTAS.itens[:1], CONTAS.periodo), efetuado)
    assert "já constam como *efetuados* no banco." in mensagem_whatsapp(r, "@Ana", MANHA)


def test_empresa_pelo_nome_do_arquivo():
    assert empresa_do_arquivo("ABC - CONTAS A PAGAR - 11.09 A 20.09.pdf") == "ABC"
    assert empresa_do_arquivo("xyz- Extrato Mensal.pdf") == "XYZ"
    assert empresa_do_arquivo("CONTAS A PAGAR - SETEMBRO.pdf") == ""
    assert empresa_do_arquivo("relatorio.pdf") == ""
