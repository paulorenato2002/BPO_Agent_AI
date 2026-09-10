"""
O worker tem de calcular o destino com a MESMA regra que o chat usou.

A regra chega ao worker dentro do payload da fila, fotografada crua do banco.
O chat, quando ARQUIVADOR_ESTRUTURA=existente, analisa com ela adaptada. Se o
worker usar a crua, todo item falha com "a regra ou o nome da empresa mudou" —
uma mensagem que não diz que a causa é essa, e que manda o usuário refazer uma
análise que vai falhar de novo.

Este teste existe porque isso aconteceu de verdade, contra o banco real.
"""
import os

import pytest

from arquivador.caminhos import Contexto, Regra, montar_destino, montar_nome
from arquivador.config import regra_para_pasta_existente

# Como a regra CLIENTE_DOCUMENTO sai do banco e entra no payload da fila.
REGRA_CRUA = {
    "codigo": "CLIENTE_DOCUMENTO",
    "nome": "Documento de cliente",
    "escopo": "mensal",
    "caminho_modelo": ["{ANO}", "{COMPETENCIA}"],
    "padrao_nome": "{CODIGO}_{COMPETENCIA}_{TIPO_DOCUMENTO}_{INSTITUICAO}_v{VERSAO}.{EXTENSAO}",
    "exige_empresa": True,
    "exige_competencia": True,
    "exige_instituicao": False,
    "projeto": None,
    "subcategoria": None,
}

CONTEXTO = dict(
    empresa_codigo="210",
    empresa_nome="TL ACADEMIA DE GINASTICA LTDA",
    pasta_empresa="210-TL ACADEMIA",
    pasta_clientes="01_CLIENTES_ATIVOS",
    competencia="2026-09",
    tipo_documento="EXTRATO_INVESTIMENTOS",
    instituicao="SICOOB",
    extensao="pdf",
)


@pytest.fixture
def modo_existente(monkeypatch):
    monkeypatch.setenv("ARQUIVADOR_ESTRUTURA", "existente")


def test_payload_cru_produz_o_caminho_da_pasta_existente(modo_existente):
    """O que o worker calcula tem de bater com o que o chat propôs."""
    regra = Regra.de_dict(regra_para_pasta_existente(REGRA_CRUA))
    ctx = Contexto(**CONTEXTO)

    destino = montar_destino(regra, ctx).caminho_relativo
    nome = montar_nome(regra, ctx)

    assert destino == "01_CLIENTES_ATIVOS/210-TL ACADEMIA/2026/09.2026"
    assert nome == (
        "210_TL_ACADEMIA_DE_GINASTICA_LTDA_2026-09_EXTRATO_INVESTIMENTOS_SICOOB_v1.pdf"
    )


def test_sem_adaptacao_o_destino_diverge(modo_existente):
    """
    A prova de que a adaptação é necessária.

    Sem ela o worker calcula `2026/2026-09` em vez de `2026/09.2026`, e o
    guarda de divergência recusa o item — que é exatamente o defeito que este
    arquivo protege.
    """
    crua = Regra.de_dict(REGRA_CRUA)
    adaptada = Regra.de_dict(regra_para_pasta_existente(REGRA_CRUA))
    ctx = Contexto(**CONTEXTO)

    assert montar_destino(crua, ctx).caminho_relativo != montar_destino(adaptada, ctx).caminho_relativo
    assert montar_nome(crua, ctx) != montar_nome(adaptada, ctx)


def test_fora_do_modo_existente_a_regra_passa_intacta(monkeypatch):
    """A adaptação é local. Sem a variável, o catálogo do banco vale como está."""
    monkeypatch.delenv("ARQUIVADOR_ESTRUTURA", raising=False)
    assert regra_para_pasta_existente(REGRA_CRUA) == REGRA_CRUA


def test_regra_interna_nunca_e_adaptada(modo_existente):
    """Documento interno não tem pasta de cliente; adaptar quebraria o caminho."""
    interna = {**REGRA_CRUA, "codigo": "INTERNO_GESTAO_ANALISE", "exige_empresa": False}
    assert regra_para_pasta_existente(interna) == interna
