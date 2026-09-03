"""
Testes da parte que escreve em disco.

Tudo acontece em pasta temporária — nenhum teste toca o OneDrive. O que
importa aqui é o que o arquivador RECUSA e o que ele nunca destrói.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from arquivador.arquivar import (
    ErroArquivamento,
    arquivar,
    garantir_pasta,
    sha256_de,
)
from arquivador.caminhos import trocar_versao_no_nome


@pytest.fixture
def raiz(tmp_path: Path) -> Path:
    d = tmp_path / "OneDriveFalso"
    d.mkdir()
    return d


@pytest.fixture
def origem(tmp_path: Path) -> Path:
    f = tmp_path / "NF_original.pdf"
    f.write_bytes(b"conteudo ficticio da nota fiscal")
    return f


SEGMENTOS = ["01_CLIENTES_ATIVOS", "ALF", "05_NOTAS_FISCAIS"]


def _arquivar(origem: Path, raiz: Path, nome="ALF_NF_v1.pdf", **kw):
    return arquivar(
        origem=origem,
        raiz=raiz,
        segmentos=SEGMENTOS,
        nome_final=nome,
        trocar_versao=trocar_versao_no_nome,
        **kw,
    )


class TestCaminhoFeliz:
    def test_cria_arvore_e_copia(self, raiz, origem):
        r = _arquivar(origem, raiz)

        assert r.status == "arquivado"
        destino = raiz.joinpath(*SEGMENTOS, "ALF_NF_v1.pdf")
        assert destino.is_file()
        assert destino.read_bytes() == origem.read_bytes()

    def test_original_permanece_por_padrao(self, raiz, origem):
        # Mover arquivo do usuário sem ele pedir se descobre tarde demais.
        _arquivar(origem, raiz)
        assert origem.is_file()

    def test_mover_remove_a_origem(self, raiz, origem):
        r = _arquivar(origem, raiz, mover=True)
        assert r.status == "arquivado"
        assert not origem.exists()

    def test_devolve_hash_e_tamanho(self, raiz, origem):
        r = _arquivar(origem, raiz)
        assert r.sha256 == sha256_de(origem)
        assert r.tamanho_bytes == origem.stat().st_size


class TestNuncaSobrescreve:
    def test_mesmo_conteudo_nao_copia_de_novo(self, raiz, origem):
        primeiro = _arquivar(origem, raiz)
        segundo = _arquivar(origem, raiz)

        assert primeiro.status == "arquivado"
        assert segundo.status == "ja_existia"
        assert segundo.caminho_final == primeiro.caminho_final

        pasta = raiz.joinpath(*SEGMENTOS)
        assert len(list(pasta.iterdir())) == 1, "criou duplicata do mesmo conteúdo"

    def test_conteudo_diferente_vira_nova_versao(self, raiz, origem, tmp_path):
        _arquivar(origem, raiz)

        outro = tmp_path / "outro.pdf"
        outro.write_bytes(b"conteudo COMPLETAMENTE diferente")
        segundo = _arquivar(outro, raiz)

        assert segundo.status == "arquivado"
        assert segundo.versao == 2
        assert segundo.nome_final == "ALF_NF_v2.pdf"

        pasta = raiz.joinpath(*SEGMENTOS)
        assert {p.name for p in pasta.iterdir()} == {"ALF_NF_v1.pdf", "ALF_NF_v2.pdf"}

    def test_o_arquivo_anterior_nao_e_alterado(self, raiz, origem, tmp_path):
        _arquivar(origem, raiz)
        primeiro = raiz.joinpath(*SEGMENTOS, "ALF_NF_v1.pdf")
        conteudo_antes = primeiro.read_bytes()

        outro = tmp_path / "outro.pdf"
        outro.write_bytes(b"outro conteudo")
        _arquivar(outro, raiz)

        assert primeiro.read_bytes() == conteudo_antes


class TestConfinamento:
    def test_segmento_com_pai_e_recusado(self, raiz, origem):
        with pytest.raises(ErroArquivamento):
            garantir_pasta(raiz, ["..", "fora"])

    def test_nao_escreve_fora_da_raiz(self, raiz, origem, tmp_path):
        vizinho = tmp_path / "vizinho"
        vizinho.mkdir()

        r = arquivar(
            origem=origem,
            raiz=raiz,
            segmentos=["..", "vizinho"],
            nome_final="invasor.pdf",
            trocar_versao=trocar_versao_no_nome,
        )

        assert r.status == "erro"
        assert not (vizinho / "invasor.pdf").exists()

    def test_raiz_inexistente_e_recusada(self, tmp_path, origem):
        r = _arquivar(origem, tmp_path / "nao_existe")
        assert r.status == "erro"
        assert "não existe" in r.erro


class TestRecusas:
    def test_origem_inexistente(self, raiz, tmp_path):
        r = _arquivar(tmp_path / "fantasma.pdf", raiz)
        assert r.status == "erro"
        assert "não encontrado" in r.erro

    def test_caminho_longo_demais_avisa_antes(self, raiz, origem):
        # O erro do Windows não explica a causa; este avisa.
        fundo = ["X" * 80 for _ in range(5)]
        r = arquivar(
            origem=origem,
            raiz=raiz,
            segmentos=fundo,
            nome_final="a.pdf",
            trocar_versao=trocar_versao_no_nome,
        )
        assert r.status == "erro"
        assert "longo demais" in r.erro


class TestDiario:
    def test_registra_uma_linha_por_operacao(self, raiz, origem, tmp_path):
        diario = tmp_path / "diario.jsonl"

        _arquivar(origem, raiz, diario=diario)
        _arquivar(origem, raiz, diario=diario)

        linhas = [json.loads(l) for l in diario.read_text(encoding="utf-8").splitlines()]
        assert len(linhas) == 2
        assert linhas[0]["status"] == "arquivado"
        assert linhas[1]["status"] == "ja_existia"
        assert linhas[0]["sha256"] == sha256_de(origem)
        assert "em" in linhas[0]

    def test_diario_e_append_only(self, raiz, origem, tmp_path):
        diario = tmp_path / "diario.jsonl"
        _arquivar(origem, raiz, diario=diario)
        primeira = diario.read_text(encoding="utf-8")

        outro = tmp_path / "outro.pdf"
        outro.write_bytes(b"diferente")
        _arquivar(outro, raiz, diario=diario)

        assert diario.read_text(encoding="utf-8").startswith(primeira)


class TestSemLixo:
    def test_nao_deixa_arquivo_parcial(self, raiz, origem):
        _arquivar(origem, raiz)
        pasta = raiz.joinpath(*SEGMENTOS)
        parciais = [p for p in pasta.iterdir() if p.name.startswith(".parcial_")]
        assert parciais == [], "sobrou temporário que o OneDrive vai sincronizar"

    def test_falha_no_meio_nao_deixa_temporario(self, raiz, origem, monkeypatch):
        import shutil as _shutil

        def copia_que_falha(*a, **kw):
            raise OSError("disco cheio")

        monkeypatch.setattr(_shutil, "copy2", copia_que_falha)

        r = _arquivar(origem, raiz)
        assert r.status == "erro"

        pasta = raiz.joinpath(*SEGMENTOS)
        assert list(pasta.iterdir()) == [], "sobrou lixo depois da falha"


class TestComprimentoDeCaminho:
    """
    A raiz real (biblioteca de equipe do SharePoint) já tem ~112 caracteres.
    Sobra pouco, e o estouro acontece no NOME do arquivo, não na pasta.
    """

    def test_pasta_cabe_mas_arquivo_nao(self, raiz, origem):
        # A pasta passa no limite; o nome longo é que estoura. Checar só a
        # pasta deixaria o erro para o Windows, que não explica a causa.
        segmentos = ["01_CLIENTES_ATIVOS", "TRANSPORTADORA", "02_RELATORIOS_E_PROJETOS"]
        nome_longo = "TRANSPORTADORA_" + "X" * 200 + "_v1.pdf"

        r = arquivar(
            origem=origem,
            raiz=raiz,
            segmentos=segmentos,
            nome_final=nome_longo,
            trocar_versao=trocar_versao_no_nome,
        )

        assert r.status == "erro"
        assert "longo demais" in r.erro
        assert "caracteres" in r.erro

    def test_a_mensagem_diz_quanto_passou(self, raiz, origem):
        r = arquivar(
            origem=origem,
            raiz=raiz,
            segmentos=["A"],
            nome_final="Y" * 300 + ".pdf",
            trocar_versao=trocar_versao_no_nome,
        )
        assert r.status == "erro"
        assert "a mais que o limite" in r.erro

    def test_nada_e_criado_quando_estoura(self, raiz, origem):
        segmentos = ["01_CLIENTES_ATIVOS", "EMPRESA"]
        arquivar(
            origem=origem,
            raiz=raiz,
            segmentos=segmentos,
            nome_final="Z" * 250 + ".pdf",
            trocar_versao=trocar_versao_no_nome,
        )
        # Nem o arquivo, nem a arvore de pastas: a checagem acontece antes
        # de qualquer mkdir.
        assert list(raiz.iterdir()) == [], "sobrou algo na raiz apesar do erro"

    def test_nenhuma_pasta_e_criada_quando_o_nome_estoura(self, raiz, origem):
        # Falhar DEPOIS de criar deixaria árvore vazia no OneDrive da equipe,
        # que sincroniza e alguém precisa limpar à mão.
        segmentos = ["01_CLIENTES_ATIVOS", "EMPRESA_QUALQUER", "SUBPASTA"]

        r = arquivar(
            origem=origem,
            raiz=raiz,
            segmentos=segmentos,
            nome_final="N" * 250 + ".pdf",
            trocar_versao=trocar_versao_no_nome,
        )

        assert r.status == "erro"
        assert not (raiz / "01_CLIENTES_ATIVOS").exists(), "criou pasta apesar de falhar"
