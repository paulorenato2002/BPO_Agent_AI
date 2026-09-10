"""Storage -> pasta sincronizada. Sem SDK, sem IA e sem limite de tempo por item.

Execute no PC: python -m arquivador.worker
Um timeout de socket detecta conexão parada; não limita a duração do trabalho.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import asdict
import os
from pathlib import Path
import socket
import tempfile
import time

from .api import ErroItem, ErroTransitorio, Supabase
from .arquivar import arquivar
from .caminhos import Contexto, ErroCaminho, Regra, montar_destino, montar_nome, trocar_versao_no_nome
from .config import RAIZ_PROJETO, carregar_config, carregar_env, regra_para_pasta_existente
from .pasta_cliente import resolver_pasta_cliente


def conferir_registro_orfao(payload: dict, item: dict, api) -> None:
    """
    O banco acha que este conteúdo já está arquivado. Confere no disco.

    POR QUE ISTO MORA AQUI E NÃO NO BANCO
    -------------------------------------
    `documentos_operacionais` tem índice único em (empresa_id, hash_sha256)
    where ativo. Enquanto a linha existe, o mesmo conteúdo não pode ser
    arquivado de novo para a mesma empresa. Isso está certo enquanto o arquivo
    ESTÁ na pasta — e vira uma trava sem saída quando alguém o apaga: o
    registro sobrevive, e `concluir_arquivamento` recusa com "já registrado em
    outro caminho".

    Só quem tem o disco montado pode desempatar. O Postgres roda no Supabase e
    a Vercel não tem a pasta; este worker tem. Então a checagem é feita aqui, e
    o banco decide com um fato observado em vez de uma suposição.

    Arquivo presente: nada muda, e a duplicata continua sendo recusada mais
    adiante — como deve. Arquivo ausente: o registro estava mentindo, é
    aposentado (não apagado) e o caminho fica livre para arquivar de novo.
    """
    empresa_id = (item.get("empresa") or {}).get("empresaId")
    hash_conteudo = payload.get("hash_sha256")
    if not empresa_id or not hash_conteudo:
        return

    registros = api.rpc("localizacao_registrada", {"p_empresa": empresa_id, "p_hash": hash_conteudo})
    if not registros:
        return

    registro = registros[0]
    caminho = registro.get("caminho_final")
    if not caminho:
        return

    if Path(caminho).is_file():
        return  # Duplicata de verdade. Quem recusa é o banco, mais adiante.

    api.rpc("aposentar_documento_orfao", {
        "p_documento": registro["documento_id"],
        "p_motivo": f"Arquivo não encontrado no destino gravado ({caminho}).",
    })
    print(
        f"  registro órfão aposentado: {registro.get('nome_final') or caminho}"
        " — o arquivo não estava mais na pasta.",
        flush=True,
    )


def executar_item(trabalho: dict, api, config) -> dict:
    payload = trabalho["payload"]
    item = payload["item"]
    if item.get("status") != "analisado" or item.get("conflitos"):
        raise ErroItem("Classificação incompleta; refaça a análise.")
    if item["empresa"].get("empresaId") and item["empresa"].get("confianca") != "confirmado":
        raise ErroItem("A empresa ainda precisa ser confirmada.")
    # A regra vem CRUA do banco, fotografada na confirmação. O chat analisou
    # com ela adaptada; aqui tem de ser a mesma, senão o destino diverge e o
    # item é recusado logo abaixo.
    regra = Regra.de_dict(regra_para_pasta_existente(payload["regra"]))
    ctx = Contexto(**payload["contexto"])
    resolver_pasta_cliente(config.raiz, regra, ctx)
    destino = montar_destino(regra, ctx)
    nome = montar_nome(regra, ctx)
    # Não entrega em um destino diferente daquele apresentado ao colaborador.
    if f"{destino.caminho_relativo}/{nome}" != item["caminhoSugerido"]:
        raise ErroItem("A regra ou o nome da empresa mudou. Refaça a análise para conferir o destino.")

    conferir_registro_orfao(payload, item, api)
    with tempfile.TemporaryDirectory(prefix="bpo-download-") as temporario:
        # Nome de usuário nunca vira caminho temporário.
        origem = Path(temporario) / "documento.bin"
        api.baixar(payload, origem)
        resultado = arquivar(origem, config.raiz, destino.segmentos, nome,
                            trocar_versao=trocar_versao_no_nome, diario=config.diario)
        if resultado.status == "erro":
            raise ErroItem(resultado.erro or "Falha ao copiar o arquivo.")
        return {**asdict(resultado), "caminho_relativo": destino.caminho_relativo}


@contextmanager
def instancia_unica(caminho: Path):
    """Lock do SO é liberado inclusive se o processo for encerrado à força."""
    with caminho.open("a+b") as arquivo:
        arquivo.seek(0)
        if os.name == "nt":
            import msvcrt
            if caminho.stat().st_size == 0:
                arquivo.write(b"0")
                arquivo.flush()
                arquivo.seek(0)
            try:
                msvcrt.locking(arquivo.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                raise SystemExit("O worker já está aberto neste PC.") from None
        else:
            import fcntl
            try:
                fcntl.flock(arquivo.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                raise SystemExit("O worker já está aberto neste PC.") from None
        try:
            yield
        finally:
            arquivo.seek(0)
            if os.name == "nt":
                msvcrt.locking(arquivo.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(arquivo.fileno(), fcntl.LOCK_UN)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uma-vez", action="store_true", help="processa no máximo um item real da fila e termina")
    args = parser.parse_args()
    carregar_env()
    config = carregar_config()
    if not config.raiz.is_dir():
        raise SystemExit("ARQUIVADOR_RAIZ não existe. Crie ou corrija a pasta antes de iniciar.")
    api = Supabase(os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""))
    worker = os.environ.get("ARQUIVADOR_WORKER_ID", socket.gethostname())
    atual = None
    resultado = None
    erro_item = None
    with instancia_unica(RAIZ_PROJETO / ".worker.lock"):
        print("Worker ligado. Aguardando pedidos confirmados. Ctrl+C para encerrar.", flush=True)
        print("O mapa de pastas é mantido por `python -m arquivador.mapeador`.", flush=True)
        while True:
            try:
                if atual is None:
                    fila = api.rpc("assumir_arquivamento", {"p_worker": worker})
                    atual = fila[0] if fila else None
                if atual:
                    if resultado is None and erro_item is None:
                        print(f"Processando pedido {atual['id']}. Arquivos grandes podem demorar mais.", flush=True)
                        try:
                            resultado = executar_item(atual, api, config)
                        except (ErroItem, ErroCaminho, OSError, ValueError, KeyError, TypeError) as e:
                            # Timeout/queda durante leitura são transitórios, não arquivo inválido.
                            if isinstance(e, (TimeoutError, ConnectionError)):
                                raise ErroTransitorio("Download interrompido. Será retomado.") from e
                            erro_item = str(e)
                    if erro_item is not None:
                        api.falhar(atual, worker, erro_item)
                        print(f"Pedido {atual['id']}: precisa de atenção. Consulte o status no chat.", flush=True)
                    else:
                        api.rpc("concluir_arquivamento", {"p_id": atual["id"], "p_worker": worker, "p_resultado": resultado})
                        print(f"Pedido {atual['id']}: salvo e registrado.", flush=True)
                    atual, resultado, erro_item = None, None, None
                if args.uma_vez:
                    return
                time.sleep(2)
            except (ErroTransitorio, TimeoutError, ConnectionError):
                # Se a cópia já terminou, repete só a confirmação no banco.
                print("Conexão interrompida. O pedido continua salvo; nova tentativa em 10s.", flush=True)
                if args.uma_vez:
                    raise SystemExit(1)
                time.sleep(10)
            except ErroItem as e:
                # Ex.: migration ausente ou finalização recusada. Não marca sucesso.
                raise SystemExit(str(e)) from None


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nWorker encerrado. O pedido em andamento será retomado na próxima abertura.")
