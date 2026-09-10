import hashlib
from pathlib import Path
from types import SimpleNamespace
import pytest

from arquivador.worker import executar_item, ErroItem, Supabase


def pedido():
    conteudo = b"documento ficticio"
    return {
        "id": "pedido-1", "payload": {
            "arquivo_id": "arquivo-1", "nome_original": "original.txt",
            "hash_sha256": hashlib.sha256(conteudo).hexdigest(), "tamanho_bytes": len(conteudo),
            "item": {"status": "analisado", "conflitos": [],
                "empresa": {"empresaId": "empresa-1", "confianca": "confirmado"},
                "caminhoSugerido": "CLIENTES/999/2026-09/999_2026-09_TESTE_v1.txt"},
            "regra": {"codigo": "TESTE", "nome": "Teste", "escopo": "mensal",
                "caminho_modelo": ["{COMPETENCIA}"], "exige_competencia": True,
                "padrao_nome": "{CODIGO}_{COMPETENCIA}_{TIPO_DOCUMENTO}_v{VERSAO}.{EXTENSAO}"},
            "contexto": {"empresa_codigo": "999", "empresa_nome": "Teste", "pasta_clientes": "CLIENTES",
                "competencia": "2026-09", "tipo_documento": "TESTE", "extensao": "txt"}
        }
    }


class API:
    def __init__(self):
        self.chamadas = 0

    def baixar(self, payload, destino):
        self.chamadas += 1
        destino.write_bytes(b"documento ficticio")


def test_worker_copia_original_e_retomada_nao_duplica(tmp_path):
    raiz = tmp_path / "destino"
    raiz.mkdir()
    config = SimpleNamespace(raiz=raiz, diario=tmp_path / "diario.jsonl")
    api = API()
    primeiro = executar_item(pedido(), api, config)
    repetido = executar_item(pedido(), api, config)
    assert primeiro["status"] == "arquivado"
    assert repetido["status"] == "ja_existia"
    assert Path(primeiro["caminho_final"]).read_bytes() == b"documento ficticio"
    assert len(list(raiz.rglob("*.txt"))) == 1


def test_empresa_provavel_nao_baixa(tmp_path):
    trabalho = pedido()
    trabalho["payload"]["item"]["empresa"]["confianca"] = "provavel"
    api = API()
    with pytest.raises(ErroItem, match="confirmada"):
        executar_item(trabalho, api, SimpleNamespace(raiz=tmp_path, diario=None))
    assert api.chamadas == 0


def test_destino_alterado_nao_baixa(tmp_path):
    trabalho = pedido()
    trabalho["payload"]["regra"]["caminho_modelo"] = ["OUTRA_PASTA"]
    api = API()
    with pytest.raises(ErroItem, match="mudou"):
        executar_item(trabalho, api, SimpleNamespace(raiz=tmp_path, diario=None))
    assert api.chamadas == 0


def test_download_confere_hash_sem_rede(tmp_path):
    from io import BytesIO
    api = Supabase("https://teste.invalid", "chave-ficticia")
    api.abrir = lambda *_: BytesIO(b"conteudo alterado")
    with pytest.raises(ErroItem, match="mudou"):
        api.baixar(pedido()["payload"], tmp_path / "download")


def test_download_preserva_bytes(tmp_path):
    from io import BytesIO
    api = Supabase("https://teste.invalid", "chave-ficticia")
    api.abrir = lambda *_: BytesIO(b"documento ficticio")
    destino = tmp_path / "download"
    api.baixar(pedido()["payload"], destino)
    assert destino.read_bytes() == b"documento ficticio"
