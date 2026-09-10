"""
Colocar o arquivo na pasta certa, sem estragar nada.

Este módulo é o único que escreve no disco, então concentra as travas:

- NUNCA sobrescreve. Se já existe arquivo com o nome, sobe a versão.
- Se o arquivo que já está lá tem o MESMO conteúdo (SHA-256 igual), não copia
  de novo: reconhece como repetição e devolve o que já existe. É o que torna
  a operação segura de repetir.
- O destino é conferido contra a raiz DEPOIS de resolvido. Link simbólico,
  "..", nome vindo do documento — nada escapa da pasta configurada.
- Escreve em arquivo temporário e só então renomeia, para nunca deixar um
  arquivo pela metade com nome definitivo (o OneDrive sincronizaria o lixo).
- Toda operação vira uma linha no diário (JSONL). Sem isso não dá para
  auditar depois o que foi para onde.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path

# Windows recusa caminho acima disso sem configuração extra. Avisamos antes de
# tentar, porque o erro do sistema operacional não explica a causa.
LIMITE_CAMINHO_WINDOWS = 255


class ErroArquivamento(Exception):
    pass


@dataclass
class Resultado:
    status: str  # "arquivado" | "ja_existia" | "erro"
    caminho_final: str | None = None
    nome_final: str | None = None
    versao: int | None = None
    sha256: str | None = None
    tamanho_bytes: int | None = None
    erro: str | None = None


def sha256_de(caminho: Path) -> str:
    h = hashlib.sha256()
    with caminho.open("rb") as f:
        for bloco in iter(lambda: f.read(1024 * 1024), b""):
            h.update(bloco)
    return h.hexdigest()


def _dentro_da_raiz(raiz: Path, alvo: Path) -> bool:
    """
    Confere confinamento com os caminhos JÁ RESOLVIDOS.

    Comparar texto não serve: `..` e link simbólico só aparecem depois de
    resolver. `resolve()` em pasta que ainda não existe funciona no Python
    moderno, então dá para checar antes de criar.
    """
    try:
        raiz_real = raiz.resolve()
        alvo_real = alvo.resolve()
    except OSError:
        return False

    return raiz_real == alvo_real or raiz_real in alvo_real.parents


def garantir_pasta(raiz: Path, segmentos: list[str]) -> Path:
    """Cria a árvore de pastas dentro da raiz e devolve a pasta final."""
    destino = raiz.joinpath(*segmentos)

    if not _dentro_da_raiz(raiz, destino):
        raise ErroArquivamento(
            f"Destino resolvido cai fora da raiz configurada: {destino}"
        )

    if len(str(destino)) > LIMITE_CAMINHO_WINDOWS:
        raise ErroArquivamento(
            f"Caminho da pasta longo demais para o Windows "
            f"({len(str(destino))} caracteres). "
            "Encurte o código da empresa ou o nome da categoria."
        )

    destino.mkdir(parents=True, exist_ok=True)
    return destino


def conferir_comprimento(pasta: Path, nome_final: str) -> None:
    """
    Confere o caminho COMPLETO, com o nome do arquivo.

    Checar só a pasta não basta: a raiz aqui já tem ~112 caracteres, e um
    nome como `EMPRESA_RAZAO_SOCIAL_LONGA_2026-09_PROJETO_TIPO_v1.pdf` come
    outros 120. A pasta passa e o arquivo estoura — com um erro do Windows
    que não diz qual foi o problema.
    """
    completo = pasta / nome_final
    tamanho = len(str(completo))

    if tamanho > LIMITE_CAMINHO_WINDOWS:
        excesso = tamanho - LIMITE_CAMINHO_WINDOWS
        raise ErroArquivamento(
            f"Caminho completo longo demais para o Windows: {tamanho} caracteres, "
            f"{excesso} a mais que o limite de {LIMITE_CAMINHO_WINDOWS}.\n"
            f"  arquivo: {nome_final}\n"
            "  Encurte o código da empresa, o tipo do documento, "
            "ou mova a raiz para um caminho mais curto."
        )


def _proximo_nome_livre(pasta: Path, nome: str, trocar_versao) -> tuple[str, int]:
    """
    Primeira versão livre a partir de 1.

    Só é chamado quando o conteúdo é DIFERENTE do que já está lá — conteúdo
    igual é tratado antes, como repetição.
    """
    versao = 1
    candidato = nome

    while (pasta / candidato).exists():
        versao += 1
        candidato = trocar_versao(nome, versao)
        if versao > 999:
            raise ErroArquivamento(
                f'Mais de 999 versões de "{nome}". Algo está errado no fluxo.'
            )

    return candidato, versao


def registrar_no_diario(diario: Path, evento: dict) -> None:
    """Uma linha JSON por operação. Append-only: nada é reescrito."""
    diario.parent.mkdir(parents=True, exist_ok=True)
    with diario.open("a", encoding="utf-8") as f:
        f.write(json.dumps(evento, ensure_ascii=False) + "\n")


def arquivar(
    origem: Path,
    raiz: Path,
    segmentos: list[str],
    nome_final: str,
    *,
    trocar_versao,
    diario: Path | None = None,
    mover: bool = False,
) -> Resultado:
    """
    Coloca `origem` em raiz/segmentos/nome_final.

    `mover=False` (padrão) COPIA: o original fica onde está. Mover arquivo do
    usuário sem ele pedir é o tipo de coisa que se descobre tarde demais.
    """
    if not origem.is_file():
        return Resultado(status="erro", erro=f"Arquivo de origem não encontrado: {origem}")

    if not raiz.is_dir():
        return Resultado(
            status="erro",
            erro=f"Raiz de arquivamento não existe: {raiz}. Confira ARQUIVADOR_RAIZ.",
        )

    try:
        # Confere o comprimento ANTES de criar qualquer pasta: falhar depois
        # de criar deixaria uma árvore vazia no OneDrive da equipe, que
        # sincroniza e alguém precisa limpar à mão.
        conferir_comprimento(raiz.joinpath(*segmentos), nome_final)

        pasta = garantir_pasta(raiz, segmentos)
        hash_origem = sha256_de(origem)
        tamanho = origem.stat().st_size

        alvo = pasta / nome_final
        versao = 1

        if alvo.exists():
            # Mesmo conteúdo: é repetição, não colisão. Não copia de novo.
            if sha256_de(alvo) == hash_origem:
                resultado = Resultado(
                    status="ja_existia",
                    caminho_final=str(alvo),
                    nome_final=alvo.name,
                    versao=None,
                    sha256=hash_origem,
                    tamanho_bytes=tamanho,
                )
                if diario:
                    registrar_no_diario(diario, _evento(origem, resultado, mover))
                return resultado

            # Uma retomada pode encontrar sua cópia em v2/v3, não apenas v1.
            # Conferir antes de escolher o próximo nome evita duplicar após
            # queda de rede entre copiar no disco e registrar no banco.
            for anterior in range(2, 1000):
                existente = pasta / trocar_versao(nome_final, anterior)
                if existente.is_file() and sha256_de(existente) == hash_origem:
                    resultado = Resultado(status="ja_existia", caminho_final=str(existente),
                        nome_final=existente.name, versao=anterior, sha256=hash_origem, tamanho_bytes=tamanho)
                    if diario:
                        registrar_no_diario(diario, _evento(origem, resultado, mover))
                    return resultado

            # Conteúdo diferente com o mesmo nome: é versão nova.
            nome_final, versao = _proximo_nome_livre(pasta, nome_final, trocar_versao)
            alvo = pasta / nome_final

        # Grava em temporário no MESMO diretório e só então renomeia: o
        # OneDrive não chega a ver um arquivo pela metade com nome definitivo.
        with tempfile.NamedTemporaryFile(
            dir=pasta, prefix=".parcial_", suffix=".tmp", delete=False
        ) as tmp:
            temporario = Path(tmp.name)

        try:
            shutil.copy2(origem, temporario)
            os.replace(temporario, alvo)
        except Exception:
            temporario.unlink(missing_ok=True)
            raise

        if mover:
            origem.unlink(missing_ok=True)

        resultado = Resultado(
            status="arquivado",
            caminho_final=str(alvo),
            nome_final=alvo.name,
            versao=versao,
            sha256=hash_origem,
            tamanho_bytes=tamanho,
        )

        if diario:
            registrar_no_diario(diario, _evento(origem, resultado, mover))
        return resultado

    except ErroArquivamento as e:
        return Resultado(status="erro", erro=str(e))
    except OSError as e:
        return Resultado(status="erro", erro=f"Falha de disco: {e}")


def _evento(origem: Path, resultado: Resultado, mover: bool) -> dict:
    return {
        "em": datetime.now(timezone.utc).isoformat(),
        "origem": str(origem),
        "operacao": "mover" if mover else "copiar",
        **asdict(resultado),
    }
