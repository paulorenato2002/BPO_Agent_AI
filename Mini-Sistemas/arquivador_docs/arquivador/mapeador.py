"""
Mapeador de pastas. Faz UMA coisa.

    python -m arquivador.mapeador

A cada 30 segundos: lê a estrutura de pastas do disco sincronizado e publica no
Supabase, para o mini-sistema saber em que pasta mora cada cliente.

POR QUE É UM PROCESSO SEPARADO
------------------------------
A varredura morava dentro do worker, entre um arquivamento e outro. Isso
amarrava duas coisas que não têm nada a ver: quem copia arquivo e quem mantém o
cadastro de pastas em dia. Consequências práticas — o mapa parava de ser
atualizado enquanto um arquivo grande era copiado, e não dava para manter o
mapa fresco sem manter o worker aberto.

Separado, cada um pode ser reiniciado, parado e diagnosticado sozinho. Este
aqui não baixa nada, não escreve arquivo nenhum e não chama IA: só lê nomes de
pasta e manda para o banco.

O QUE ELE NÃO DECIDE
--------------------
De quem é cada pasta. Ele manda a lista crua de nomes; o casamento com o código
da empresa acontece no banco, em `sincronizar_pastas_empresas`. A regra fica num
lugar só — se ela existisse aqui também, as duas pontas divergiriam em silêncio.
"""
from __future__ import annotations

import argparse
import os
import socket
import sys
import time

from .api import ErroItem, ErroTransitorio, Supabase
from .config import carregar_config, carregar_env, carregar_regras
from .mapear import mapear_uma_vez, resumir

INTERVALO_PADRAO_S = 30

for _saida in (sys.stdout, sys.stderr):
    try:
        _saida.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Mantém o mapa de pastas de cliente em dia.")
    parser.add_argument(
        "--intervalo", type=int, default=INTERVALO_PADRAO_S, metavar="SEG",
        help=f"segundos entre varreduras (padrão: {INTERVALO_PADRAO_S})",
    )
    parser.add_argument(
        "--uma-vez", action="store_true", help="varre uma vez e termina"
    )
    args = parser.parse_args()

    carregar_env()
    config = carregar_config()
    dados = carregar_regras(config.regras)

    if not config.raiz.is_dir():
        raise SystemExit(
            f"ARQUIVADOR_RAIZ não existe: {config.raiz}\n"
            "  Corrija a pasta antes de iniciar o mapeador."
        )

    api = Supabase(
        os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    )
    identificador = os.environ.get("ARQUIVADOR_WORKER_ID", socket.gethostname())
    intervalo = max(5, args.intervalo)

    print(f"Mapeador ligado. Raiz: {config.raiz}", flush=True)
    print(f"Publicando como '{identificador}' a cada {intervalo}s. Ctrl+C para encerrar.\n", flush=True)

    # Só imprime quando algo muda. Um mapeador que fala a cada 30 segundos vira
    # ruído, e ninguém repara na linha que importa.
    ultimo_resumo: str | None = None

    while True:
        try:
            relatorios = mapear_uma_vez(api, config.raiz, dados, identificador)
            resumo = resumir(relatorios)
            if resumo != ultimo_resumo:
                print(f"[{time.strftime('%H:%M:%S')}] mapa atualizado", flush=True)
                print(resumo, flush=True)
                ultimo_resumo = resumo
        except ErroTransitorio as e:
            # Rede caindo é rotina num PC de escritório. O mapa continua valendo
            # no banco; a próxima volta conserta.
            print(f"[{time.strftime('%H:%M:%S')}] {e} Nova tentativa em {intervalo}s.", flush=True)
            ultimo_resumo = None
        except ErroItem as e:
            # Migration ausente ou permissão negada: repetir não resolve.
            raise SystemExit(str(e)) from None
        except OSError as e:
            # Pasta sincronizando, unidade de rede fora do ar. Não é fatal.
            print(f"[{time.strftime('%H:%M:%S')}] Falha ao ler o disco: {e}", flush=True)
            ultimo_resumo = None

        if args.uma_vez:
            return 0
        time.sleep(intervalo)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nMapeador encerrado. O mapa que já foi publicado continua valendo.")
