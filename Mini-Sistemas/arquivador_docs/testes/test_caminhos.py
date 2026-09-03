"""
Testes do núcleo puro: onde o documento vai e como se chama.

Tudo fictício. Nenhum cliente real, nenhum caminho de máquina.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from arquivador.caminhos import (
    Contexto,
    ErroCaminho,
    Regra,
    montar_destino,
    montar_nome,
    normalizar,
    sanitizar_segmento,
    trocar_versao_no_nome,
)

REGRA_MENSAL = Regra(
    codigo="MENSAL_NOTAS_FISCAIS",
    nome="Notas fiscais",
    escopo="mensal",
    caminho_modelo=["01_DOCUMENTOS_MENSAIS", "{ANO}", "{COMPETENCIA}", "05_NOTAS_FISCAIS"],
    padrao_nome="{CODIGO}_{EMPRESA}_{COMPETENCIA}_{TIPO_DOCUMENTO}_{INSTITUICAO}_v{VERSAO}.{EXTENSAO}",
    exige_empresa=True,
    exige_competencia=True,
)

REGRA_INTERNA = Regra(
    codigo="INTERNO_MODELO_CONTRATO",
    nome="Modelos de contrato",
    escopo="interno",
    caminho_modelo=["00_INTERNO", "02_MODELOS_DE_CONTRATOS"],
    padrao_nome="{TIPO_DOCUMENTO}_{DATA_DOCUMENTO}_v{VERSAO}.{EXTENSAO}",
    exige_empresa=False,
)

CTX = Contexto(
    empresa_codigo="ALF",
    empresa_nome="Panificadora Alfa",
    pasta_clientes="01_CLIENTES_ATIVOS",
    competencia="2026-09",
    tipo_documento="NOTA_FISCAL",
    extensao="pdf",
)


class TestDestino:
    def test_empresa_nasce_dentro_do_container(self):
        d = montar_destino(REGRA_MENSAL, CTX)
        assert d.caminho_relativo == (
            "01_CLIENTES_ATIVOS/ALF/01_DOCUMENTOS_MENSAIS/2026/2026-09/05_NOTAS_FISCAIS"
        )
        assert d.segmentos[0] == "01_CLIENTES_ATIVOS"

    def test_cliente_inativo_vai_para_o_outro_container(self):
        ctx = Contexto(**{**CTX.__dict__, "pasta_clientes": "02_CLIENTES_INATIVOS"})
        assert montar_destino(REGRA_MENSAL, ctx).segmentos[0] == "02_CLIENTES_INATIVOS"

    def test_regra_interna_comeca_na_raiz(self):
        d = montar_destino(REGRA_INTERNA, Contexto())
        assert d.caminho_relativo == "00_INTERNO/02_MODELOS_DE_CONTRATOS"

    def test_ano_sai_da_competencia(self):
        assert "2026" in montar_destino(REGRA_MENSAL, CTX).segmentos

    def test_sem_competencia_diz_o_que_falta(self):
        ctx = Contexto(**{**CTX.__dict__, "competencia": None})
        with pytest.raises(ErroCaminho) as e:
            montar_destino(REGRA_MENSAL, ctx)
        assert "competencia" in e.value.faltando

    def test_sem_container_recusa(self):
        # Sem isso a pasta do cliente cairia solta na raiz do OneDrive.
        ctx = Contexto(**{**CTX.__dict__, "pasta_clientes": None})
        with pytest.raises(ErroCaminho) as e:
            montar_destino(REGRA_MENSAL, ctx)
        assert "pasta_clientes" in e.value.faltando

    @pytest.mark.parametrize("ruim", ["2026-13", "09-2026", "2026/09", "2026-9", "abc"])
    def test_competencia_fora_do_formato(self, ruim):
        ctx = Contexto(**{**CTX.__dict__, "competencia": ruim})
        with pytest.raises(ErroCaminho):
            montar_destino(REGRA_MENSAL, ctx)


class TestSeguranca:
    def test_codigo_malicioso_nao_escapa(self):
        ctx = Contexto(**{**CTX.__dict__, "empresa_codigo": "../../Windows/System32"})
        d = montar_destino(REGRA_MENSAL, ctx)
        assert ".." not in d.caminho_relativo
        assert all("/" not in s and "\\" not in s for s in d.segmentos)

    def test_container_malicioso_tambem_e_limpo(self):
        ctx = Contexto(**{**CTX.__dict__, "pasta_clientes": "../fora"})
        d = montar_destino(REGRA_MENSAL, ctx)
        assert ".." not in d.caminho_relativo

    @pytest.mark.parametrize("reservado", ["CON", "PRN", "AUX", "NUL", "COM1", "LPT1"])
    def test_nome_reservado_do_windows_e_desviado(self, reservado):
        # O Windows recusa criar pasta com esses nomes; sem o desvio o
        # arquivamento quebraria só para certos clientes.
        assert sanitizar_segmento(reservado) != reservado

    def test_ponto_e_espaco_no_fim_somem(self):
        # O Explorer descarta e o caminho deixa de bater com o registro.
        assert sanitizar_segmento("PASTA. ") == "PASTA"

    def test_caracteres_proibidos_do_windows(self):
        limpo = sanitizar_segmento('a<b>c:d"e|f?g*h')
        assert not any(c in limpo for c in '<>:"|?*')


class TestNome:
    def test_nome_completo(self):
        ctx = Contexto(**{**CTX.__dict__, "instituicao": "Itau", "versao": 2})
        assert montar_nome(REGRA_MENSAL, ctx) == (
            "ALF_PANIFICADORA_ALFA_2026-09_NOTA_FISCAL_ITAU_v2.pdf"
        )

    def test_placeholder_opcional_some_sem_deixar_rastro(self):
        nome = montar_nome(REGRA_MENSAL, CTX)
        assert "{" not in nome
        assert "__" not in nome
        assert nome == "ALF_PANIFICADORA_ALFA_2026-09_NOTA_FISCAL_v1.pdf"

    def test_extensao_normalizada(self):
        ctx = Contexto(**{**CTX.__dict__, "extensao": ".PDF"})
        nome = montar_nome(REGRA_MENSAL, ctx)
        assert nome.endswith(".pdf")
        assert ".." not in nome

    def test_sem_extensao_recusa(self):
        ctx = Contexto(**{**CTX.__dict__, "extensao": None})
        with pytest.raises(ErroCaminho) as e:
            montar_nome(REGRA_MENSAL, ctx)
        assert "extensao" in e.value.faltando

    def test_acento_e_espaco_viram_nome_seguro(self):
        ctx = Contexto(**{**CTX.__dict__, "empresa_nome": "Ação & Serviços Ltda"})
        nome = montar_nome(REGRA_MENSAL, ctx)
        assert not any(c in nome for c in "áàâãéíóúçÇ& ")

    def test_data_fora_do_formato_recusa(self):
        ctx = Contexto(tipo_documento="MODELO", extensao="docx", data_documento="31/12/2026")
        with pytest.raises(ErroCaminho):
            montar_nome(REGRA_INTERNA, ctx)


class TestVersao:
    def test_troca_versao_existente(self):
        assert trocar_versao_no_nome("ALF_2026-09_NF_v1.pdf", 3) == "ALF_2026-09_NF_v3.pdf"

    def test_acrescenta_quando_nao_tem(self):
        assert trocar_versao_no_nome("relatorio.pdf", 2) == "relatorio_v2.pdf"

    def test_arquivo_sem_extensao(self):
        assert trocar_versao_no_nome("SEMEXT", 2) == "SEMEXT_v2"


class TestNormalizar:
    def test_remove_acento_e_maiusculiza(self):
        assert normalizar("Ação Ltda") == "ACAO_LTDA"

    def test_colapsa_espacos_em_underscore(self):
        assert normalizar("a   b") == "A_B"

    def test_hifen_sobrevive(self):
        # De proposito: competencia e "2026-09". Trocar hifen por underscore
        # quebraria o formato que o resto do sistema espera.
        assert normalizar("2026-09") == "2026-09"
