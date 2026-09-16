from datetime import datetime

from conferencia import conferir_tres
from core import Documento, Item
from mensagem import mensagem_whatsapp, pendencias_antes_de_enviar, saudacao


def doc(tipo, itens, periodo=None):
    return Documento(f"{tipo}.pdf", tipo, tipo, 1, itens, total_impresso=sum(i.valor for i in itens), periodo=periodo or [])


CONTAS = doc("contas", [Item("1", "COMPANHIA LUZ", 30000, "10/09/2026", "Energia", "Energia", situacao="Em aberto"),
                        Item("2", "AGENCIA ZETA", 30000, "11/09/2026", "Agenciamento", "Serviços", situacao="Em aberto")],
             ["04/09/2026", "13/09/2026"])
BANCO = doc("itau", [Item("1", "COMPANHIA LUZ SA", 30000, "10/09/2026", situacao="Pendente de autorização")],
            ["04/09/2026", "13/09/2026"])
MANHA = datetime(2026, 9, 16, 9)


def test_modelo_com_observacoes():
    r = conferir_tres(CONTAS, BANCO, observacoes="* A folha de pagamento encontra-se em apuração.\n"
                                                 "* Zeta — boleto ainda não recebido/gerado.")
    assert mensagem_whatsapp(r, "Fulano", MANHA) == (
        "Bom dia, @Fulano\n"
        "Segue abaixo o contas a pagar do período de 04/09 a 13/09.\n"
        "Os agendamentos realizados encontram-se no banco, aguardando assinatura/autorização.\n"
        "Observações:\n"
        "\n"
        "* A folha de pagamento encontra-se em apuração.\n"
        "* Zeta — boleto ainda não recebido/gerado.\n"
        "\n"
        "Os demais lançamentos encontram-se agendados.\n"
        "Abaixo, envio a relação dos agendamentos para conferência e autorização.\n"
        "Fico à disposição para qualquer ajuste ou auxílio!\n")
    assert pendencias_antes_de_enviar(r) == []


def test_modelo_sem_observacoes_avisa_o_que_falta():
    r = conferir_tres(CONTAS, BANCO)
    texto = mensagem_whatsapp(r, "", datetime(2026, 9, 16, 15))
    assert texto.startswith("Boa tarde, @cliente\n")
    assert "Observações" not in texto
    assert "Todos os lançamentos encontram-se agendados." in texto
    assert pendencias_antes_de_enviar(r) == ["AGENCIA ZETA: Faltou agendar"]


def test_saudacao_e_banco_efetuado():
    assert [saudacao(datetime(2026, 1, 1, h)) for h in (8, 13, 20)] == ["Bom dia", "Boa tarde", "Boa noite"]
    efetuado = doc("itau", [Item("1", "COMPANHIA LUZ SA", 30000, "10/09/2026", situacao="Efetuado")], ["04/09/2026", "13/09/2026"])
    r = conferir_tres(doc("contas", CONTAS.itens[:1], CONTAS.periodo), efetuado)
    assert "já constam como efetuados" in mensagem_whatsapp(r, "@Ana", MANHA)
