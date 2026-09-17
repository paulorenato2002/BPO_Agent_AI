"""Um lote de conferência: lê os arquivos, valida o conjunto e confere.

Usado pela tela (app.py) e pela entrada JSON do agente (cli.py), para que as
duas apliquem exatamente as mesmas regras de bloqueio.
"""
from dataclasses import dataclass, field

from conferencia import Relatorio, conferir_tres, nome_da_lista
from core import Documento, brl, ler_pdf
from fontes import ler_planilha, ler_texto
from mensagem import empresa_do_arquivo, mensagem_whatsapp, pendencias_antes_de_enviar

TIPOS_BANCO = ["itau", "sicoob"]
EXTENSOES = ("pdf", "xlsx", "csv", "txt")
NOMES_TIPO = {"contas": "contas a pagar", "itau": "agendamentos Itaú", "sicoob": "agendamentos Sicoob",
              "folha": "extrato da folha", "desconhecido": "layout não reconhecido"}


@dataclass
class Lote:
    docs: list[Documento] = field(default_factory=list)
    erros: list[str] = field(default_factory=list)
    relatorio: Relatorio | None = None


def ler_relacoes(texto: str) -> tuple[dict[str, str], list[str]]:
    relacoes, invalidas = {}, []
    for linha in (texto or "").splitlines():
        if not linha.strip():
            continue
        if "=" not in linha or not all(p.strip() for p in linha.split("=", 1)):
            invalidas.append(linha)
        else:
            a, b = linha.split("=", 1)
            relacoes[a.strip()] = b.strip()
    return relacoes, invalidas


def ler_arquivo(nome: str, dados: bytes) -> list[Documento]:
    ext = nome.lower().rsplit(".", 1)[-1] if "." in nome else ""
    if ext == "pdf":
        return [ler_pdf(nome, dados)]
    if ext in ("xlsx", "csv", "xls"):
        return ler_planilha(nome, dados)
    if ext == "txt":
        return ler_texto(nome, dados.decode("utf-8-sig", errors="replace"))
    raise ValueError(f"formato .{ext or '?'} não é lido (use PDF, XLSX, CSV ou TXT)")


def nome_do_tipo(d: Documento) -> str:
    return nome_da_lista(d.rotulo) if d.tipo == "lista" else NOMES_TIPO.get(d.tipo, d.tipo)


def validar(docs: list[Documento]) -> list[str]:
    erros = []
    contas = [d for d in docs if d.tipo == "contas"]
    bancos = [d for d in docs if d.tipo in TIPOS_BANCO]
    folhas = [d for d in docs if d.tipo == "folha"]
    listas = [d for d in docs if d.tipo == "lista"]
    desconhecidos = [d.arquivo for d in docs if d.tipo == "desconhecido"]
    if desconhecidos:
        erros.append("Layout não reconhecido: " + ", ".join(desconhecidos) + ".")
    if len(contas) != 1 or len(bancos) > 1 or len(folhas) > 1 or not (bancos or folhas or listas):
        erros.append("Envie um contas a pagar e, da mesma empresa, os agendamentos do banco, o extrato da folha "
                     "e/ou as planilhas (VT, VA).")
    if len({d.hash for d in docs}) != len(docs):
        erros.append("Arquivo repetido no lote.")
    if len({d.cnpj for d in docs if d.cnpj}) > 1:
        erros.append("Os arquivos são de CNPJs diferentes. Separe as empresas.")
    for d in docs:
        if d.integro:
            continue
        if d.tipo == "lista":
            erros.append(f"{d.arquivo}: " + (" ".join(d.alertas) or "nenhuma linha com nome e valor."))
        elif d.tipo != "desconhecido":
            erros.append(f"{d.arquivo}: leitura incompleta ou total que não fecha. Conferência bloqueada.")
    return erros


def conferir_lote(fontes: list[tuple[str, bytes]], relacoes: dict[str, str] | None = None,
                  observacoes: str = "", dados_texto: str = "") -> Lote:
    lote = Lote()
    for nome, dados in fontes:
        try:
            lote.docs += ler_arquivo(nome, dados)
        except ValueError as exc:
            lote.erros.append(f"{nome}: {str(exc).rstrip('.')}.")
        except Exception as exc:
            lote.erros.append(f"{nome}: leitura interrompida ({type(exc).__name__}). Verifique o arquivo.")
    if (dados_texto or "").strip():
        lote.docs += ler_texto("dados da mensagem", dados_texto)
    if not lote.docs and not lote.erros:
        lote.erros.append("Nenhum arquivo enviado.")
        return lote
    lote.erros += validar(lote.docs)
    if lote.erros:
        return lote
    por_tipo = lambda tipos: next((d for d in lote.docs if d.tipo in tipos), None)
    lote.relatorio = conferir_tres(por_tipo(["contas"]), por_tipo(TIPOS_BANCO), por_tipo(["folha"]),
                                   relacoes or {}, observacoes=observacoes,
                                   listas=[d for d in lote.docs if d.tipo == "lista"])
    return lote


def empresa_do_lote(lote: Lote) -> str:
    contas = next((d for d in lote.docs if d.tipo == "contas"), None)
    return empresa_do_arquivo(contas.arquivo) if contas else ""


def resumo_documento(d: Documento) -> dict:
    return {"arquivo": d.arquivo, "tipo": nome_do_tipo(d), "registros": len(d.itens),
            "soma_lida": brl(d.total),
            "total_impresso": brl(d.total_impresso) if d.total_impresso is not None else None,
            "validado": d.integro, "cnpj_no_cabecalho": bool(d.cnpj),
            "periodo": " a ".join(d.periodo), "alertas": d.alertas}


def para_json(lote: Lote, cliente: str = "", empresa: str = "") -> dict:
    """Resposta do agente. Não carrega evidências nem itens: só o necessário para conversar."""
    r = lote.relatorio
    saida = {"ok": r is not None, "erros": lote.erros,
             "documentos": [resumo_documento(d) for d in lote.docs]}
    if r is None:
        return saida
    empresa = (empresa or "").strip() or empresa_do_lote(lote)
    avisos = []
    if any(not d.cnpj for d in lote.docs if d.tipo != "lista"):
        avisos.append("Há relatório sem CNPJ no cabeçalho. Confirme que é da mesma empresa; o nome do arquivo não comprova.")
    if not empresa:
        avisos.append("Não identifiquei o nome curto da empresa para a mensagem: pergunte ao usuário (ex.: L2H).")
    saida.update({"divergencias": len(r.divergentes), "avisos": avisos, "empresa": empresa,
                  "relatorio_markdown": r.markdown(),
                  "pendencias_antes_de_enviar": pendencias_antes_de_enviar(r),
                  "mensagem_whatsapp": mensagem_whatsapp(r, cliente, empresa=empresa)})
    return saida
