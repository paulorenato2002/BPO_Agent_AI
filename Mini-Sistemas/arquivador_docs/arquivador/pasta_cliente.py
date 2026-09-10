from pathlib import Path
from .caminhos import Contexto, ErroCaminho, Regra


def resolver_pasta_cliente(raiz: Path, regra: Regra, ctx: Contexto) -> None:
    if not regra.exige_empresa or "{COMPETENCIA_PASTA}" not in regra.caminho_modelo:
        return
    container = ctx.pasta_clientes or ""
    if not container or "/" in container or "\\" in container or container == "..":
        raise ErroCaminho("Contêiner inválido.")
    pasta = raiz / container
    candidatas = [p for p in pasta.iterdir() if p.is_dir() and p.name.startswith(f"{ctx.empresa_codigo}-")]
    if len(candidatas) != 1:
        raise ErroCaminho(f"Esperava uma pasta existente com prefixo {ctx.empresa_codigo}-; encontrei {len(candidatas)}.")
    if not candidatas[0].resolve().is_relative_to(raiz.resolve()):
        raise ErroCaminho("Pasta do cliente fora da raiz.")
    ctx.pasta_empresa = candidatas[0].name
