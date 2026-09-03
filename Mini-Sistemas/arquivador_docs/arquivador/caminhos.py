"""
Onde o documento vai e como ele se chama.

Módulo PURO: não toca disco, não fala com rede. Recebe (regra + contexto) e
devolve os pedaços do caminho e o nome final. É a parte que decide, então é a
parte que precisa ser testável sem OneDrive nenhum.

Nenhum caminho é escrito aqui dentro. Tudo vem de `dados/regras.json`, que é
gerado a partir do banco.

PLACEHOLDERS DE CAMINHO: {ANO} {COMPETENCIA} {PROJETO}
PLACEHOLDERS DE NOME:    {CODIGO} {EMPRESA} {COMPETENCIA} {TIPO_DOCUMENTO}
                         {INSTITUICAO} {PROJETO} {DATA_DOCUMENTO} {VERSAO}
                         {EXTENSAO}

Placeholder opcional sem valor é REMOVIDO e os separadores que sobram são
colapsados — nunca sai "{INSTITUICAO}" literal nem "__" no meio do nome.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

FORMATO_COMPETENCIA = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
FORMATO_DATA = re.compile(r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$")

# Nomes que o Windows recusa como arquivo ou pasta, mesmo com extensão.
RESERVADOS_WINDOWS = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


class ErroCaminho(Exception):
    """Falha previsível de montagem. Carrega o que faltou, para poder perguntar."""

    def __init__(self, mensagem: str, faltando: list[str] | None = None) -> None:
        super().__init__(mensagem)
        self.faltando = faltando or []


@dataclass(frozen=True)
class Regra:
    codigo: str
    nome: str
    escopo: str
    caminho_modelo: list[str]
    padrao_nome: str
    exige_empresa: bool = True
    exige_competencia: bool = False
    exige_instituicao: bool = False
    projeto: str | None = None
    subcategoria: str | None = None

    @staticmethod
    def de_dict(d: dict) -> "Regra":
        return Regra(
            codigo=d["codigo"],
            nome=d["nome"],
            escopo=d["escopo"],
            caminho_modelo=list(d["caminho_modelo"]),
            padrao_nome=d["padrao_nome"],
            exige_empresa=bool(d.get("exige_empresa", True)),
            exige_competencia=bool(d.get("exige_competencia", False)),
            exige_instituicao=bool(d.get("exige_instituicao", False)),
            projeto=d.get("projeto"),
            subcategoria=d.get("subcategoria"),
        )


@dataclass
class Contexto:
    """O que se sabe do documento. Campo ausente é None, nunca chute."""

    empresa_codigo: str | None = None
    empresa_nome: str | None = None
    pasta_clientes: str | None = None
    competencia: str | None = None
    instituicao: str | None = None
    tipo_documento: str | None = None
    data_documento: str | None = None
    projeto: str | None = None
    versao: int = 1
    extensao: str | None = None


@dataclass
class Destino:
    segmentos: list[str] = field(default_factory=list)

    @property
    def caminho_relativo(self) -> str:
        return "/".join(self.segmentos)


def normalizar(valor: str) -> str:
    """Sem acento, maiúsculo, só letra/número/_/-. Para nome de pasta e arquivo."""
    sem_acento = "".join(
        c for c in unicodedata.normalize("NFD", valor) if unicodedata.category(c) != "Mn"
    )
    limpo = re.sub(r"[^a-zA-Z0-9_-]+", "_", sem_acento)
    limpo = re.sub(r"_{2,}", "_", limpo).strip("_")
    return limpo.upper()


def sanitizar_segmento(valor: str) -> str:
    """
    Deixa um pedaço de caminho seguro para o Windows.

    Corta barra, caractere de controle e os símbolos que o Windows recusa; tira
    ponto e espaço do fim (o Explorer some com eles e o caminho deixa de bater);
    e desvia dos nomes reservados. É a barreira que impede um valor vindo do
    documento de escapar da pasta raiz.
    """
    base = re.split(r"[/\\]", valor)[-1]
    base = "".join(c for c in base if ord(c) >= 32 and c != "\x7f")
    base = re.sub(r'[<>:"|?*]', "_", base)
    base = base.strip().rstrip(". ")

    if base.upper().split(".")[0] in RESERVADOS_WINDOWS:
        base = f"_{base}"

    return base[:150]


def _competencia_valida(competencia: str) -> None:
    if not FORMATO_COMPETENCIA.match(competencia):
        raise ErroCaminho(
            f'Competência "{competencia}" fora do formato AAAA-MM.', ["competencia"]
        )


def conferir_exigencias(regra: Regra, ctx: Contexto) -> list[str]:
    """Devolve a LISTA do que falta — quem chama precisa saber o que perguntar."""
    faltando: list[str] = []

    if regra.exige_empresa:
        if not (ctx.empresa_codigo or ctx.empresa_nome):
            faltando.append("empresa_codigo")
        # Sem o contêiner a pasta do cliente cairia solta na raiz.
        if not ctx.pasta_clientes:
            faltando.append("pasta_clientes")

    if regra.exige_competencia and not ctx.competencia:
        faltando.append("competencia")
    if regra.exige_instituicao and not ctx.instituicao:
        faltando.append("instituicao")

    usa_projeto = any("{PROJETO}" in s for s in regra.caminho_modelo)
    if usa_projeto and not (ctx.projeto or regra.projeto):
        faltando.append("projeto")

    return faltando


def montar_destino(regra: Regra, ctx: Contexto) -> Destino:
    """Expande a regra na lista de pastas, da raiz até a pasta final."""
    faltando = conferir_exigencias(regra, ctx)
    if faltando:
        raise ErroCaminho(
            f"A regra {regra.codigo} exige: {', '.join(faltando)}.", faltando
        )

    if ctx.competencia:
        _competencia_valida(ctx.competencia)

    ano = ctx.competencia[:4] if ctx.competencia else None
    projeto = normalizar(ctx.projeto or regra.projeto or "") or None

    substituicoes = {
        "ANO": ano,
        "COMPETENCIA": ctx.competencia,
        "PROJETO": projeto,
    }

    segmentos: list[str] = []

    if regra.exige_empresa:
        # 1º nível: contêiner de clientes. 2º: a empresa. A pasta do cliente
        # nunca fica solta na raiz.
        container = sanitizar_segmento(ctx.pasta_clientes or "")
        if not container:
            raise ErroCaminho("Contêiner de clientes vazio.", ["pasta_clientes"])
        segmentos.append(container)

        empresa = normalizar(ctx.empresa_codigo or ctx.empresa_nome or "")
        if not empresa:
            raise ErroCaminho("Nome da pasta da empresa vazio.", ["empresa_codigo"])
        segmentos.append(empresa)

    for modelo in regra.caminho_modelo:
        faltou: str | None = None

        def troca(m: re.Match[str]) -> str:
            nonlocal faltou
            chave = m.group(1)
            if chave not in substituicoes:
                return m.group(0)
            valor = substituicoes[chave]
            if valor is None:
                faltou = chave
                return m.group(0)
            return valor

        expandido = re.sub(r"\{([A-Z_]+)\}", troca, modelo)

        if faltou:
            raise ErroCaminho(
                f"A regra {regra.codigo} usa {{{faltou}}} no caminho, "
                "mas o valor não foi informado.",
                [faltou.lower()],
            )

        seguro = sanitizar_segmento(expandido)
        if not seguro:
            raise ErroCaminho(
                f'O segmento "{modelo}" da regra {regra.codigo} ficou vazio.'
            )
        segmentos.append(seguro)

    if not segmentos:
        raise ErroCaminho(f"A regra {regra.codigo} não produziu nenhuma pasta.")

    return Destino(segmentos=segmentos)


def montar_nome(regra: Regra, ctx: Contexto) -> str:
    """Nome final do arquivo. O nome original NUNCA é sobrescrito no registro."""
    faltando = conferir_exigencias(regra, ctx)
    if not ctx.extensao:
        faltando.append("extensao")
    if "{TIPO_DOCUMENTO}" in regra.padrao_nome and not ctx.tipo_documento:
        faltando.append("tipo_documento")
    if faltando:
        raise ErroCaminho(
            f"Para nomear pela regra {regra.codigo} faltam: {', '.join(faltando)}.",
            faltando,
        )

    if ctx.data_documento and not FORMATO_DATA.match(ctx.data_documento):
        raise ErroCaminho(
            f'Data "{ctx.data_documento}" fora do formato AAAA-MM-DD.',
            ["data_documento"],
        )

    empresa_nome = ctx.empresa_nome or ctx.empresa_codigo or ""
    extensao = (ctx.extensao or "").lower().lstrip(".")

    # None = placeholder opcional sem valor: sai do nome em vez de virar lixo.
    substituicoes: dict[str, str | None] = {
        "CODIGO": normalizar(ctx.empresa_codigo or "") or None,
        "EMPRESA": normalizar(empresa_nome) or None,
        "COMPETENCIA": ctx.competencia,
        "TIPO_DOCUMENTO": normalizar(ctx.tipo_documento or "") or None,
        "INSTITUICAO": normalizar(ctx.instituicao or "") or None,
        "PROJETO": normalizar(ctx.projeto or regra.projeto or "") or None,
        "DATA_DOCUMENTO": ctx.data_documento,
        "VERSAO": str(ctx.versao),
        "EXTENSAO": extensao,
    }

    bruto = re.sub(
        r"\{([A-Z_]+)\}",
        lambda m: substituicoes.get(m.group(1), m.group(0)) or "",
        regra.padrao_nome,
    )

    # Colapsa o rastro do que foi removido: "A__B" -> "A_B", "A_.pdf" -> "A.pdf".
    limpo = re.sub(r"_{2,}", "_", bruto)
    limpo = re.sub(r"_+\.", ".", limpo).strip("_")

    nome = sanitizar_segmento(limpo)
    if not nome:
        raise ErroCaminho(f"O nome gerado pela regra {regra.codigo} ficou vazio.")

    return nome


def trocar_versao_no_nome(nome: str, versao: int) -> str:
    """Troca o _vN antes da extensão. Se não houver, acrescenta."""
    novo, trocas = re.subn(r"_v\d+(\.[^.]+)$", rf"_v{versao}\1", nome)
    if trocas:
        return novo

    if "." in nome:
        base, _, ext = nome.rpartition(".")
        return f"{base}_v{versao}.{ext}"
    return f"{nome}_v{versao}"
