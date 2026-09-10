"""
Conversa com o Supabase pela biblioteca padrão.

Extraído do worker porque a varredura de pastas também precisa falar com o
banco, e um import cruzado entre worker e varredura seria circular.

Sem SDK de propósito: o mini-sistema roda em qualquer PC com Python instalado,
sem `pip install` e sem cadeia de dependência para manter.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen


class ErroTransitorio(Exception):
    """Sem confirmação remota: repetir mantendo a identidade do trabalho."""


class ErroItem(Exception):
    """Arquivo/regra/configuração precisa de atenção humana."""


class Supabase:
    def __init__(self, url: str, chave: str):
        if urlsplit(url).scheme != "https" or not chave:
            raise SystemExit(
                "Configure SUPABASE_URL (https) e SUPABASE_SERVICE_ROLE_KEY no .env do mini-sistema."
            )
        self.url = url.rstrip("/")
        self.headers = {"apikey": chave, "Authorization": f"Bearer {chave}"}

    def abrir(self, caminho: str, metodo="GET", dados=None):
        headers = {**self.headers, "Content-Type": "application/json"}
        corpo = json.dumps(dados).encode() if dados is not None else None
        pedido = Request(self.url + caminho, data=corpo, headers=headers, method=metodo)
        try:
            return urlopen(pedido, timeout=60)
        except HTTPError as e:
            # Nunca imprimir cabeçalhos/chaves, corpo de erro ou URL autenticada.
            if e.code in (408, 429) or e.code >= 500:
                raise ErroTransitorio(f"Serviço indisponível (HTTP {e.code}).") from None
            raise ErroItem(
                f"Supabase recusou a operação (HTTP {e.code}). "
                "Confira configuração e migration da fila."
            ) from None
        except (URLError, TimeoutError, ConnectionError) as e:
            raise ErroTransitorio("Sem conexão com o Supabase; o pedido continua salvo.") from e

    def rpc(self, nome: str, dados: dict):
        with self.abrir(f"/rest/v1/rpc/{nome}", "POST", dados) as resposta:
            corpo = resposta.read()
        # Função que retorna `void` responde 204 sem corpo. É o caso de
        # `falhar_arquivamento`: sem isto, registrar uma falha quebrava o
        # worker com JSONDecodeError — e o erro que aparecia no terminal era o
        # do decodificador, não o do item, escondendo a causa real.
        if not corpo.strip():
            return None
        return json.loads(corpo)

    def baixar(self, payload: dict, destino: Path):
        caminho = quote(f"{payload['arquivo_id']}/{payload['nome_original']}", safe="/")
        h = hashlib.sha256()
        tamanho = 0
        with self.abrir(f"/storage/v1/object/authenticated/anexos-agente/{caminho}") as resposta:
            with destino.open("wb") as arquivo:
                while bloco := resposta.read(1024 * 1024):
                    arquivo.write(bloco)
                    h.update(bloco)
                    tamanho += len(bloco)
        if h.hexdigest() != payload["hash_sha256"] or tamanho != payload["tamanho_bytes"]:
            raise ErroItem("O conteúdo do Storage mudou desde a confirmação. Refaça a análise.")

    def falhar(self, trabalho: dict, worker: str, erro: str):
        # Mantém proposta e aviso persistido consistentes com a falha do item.
        return self.rpc(
            "falhar_arquivamento",
            {"p_id": trabalho["id"], "p_worker": worker, "p_erro": erro[:500]},
        )
