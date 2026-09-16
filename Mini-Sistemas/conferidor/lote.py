"""Um lote de conferência: lê os PDFs, valida o conjunto e confere.

Usado pela tela (app.py) e pela entrada JSON do agente (cli.py), para que as
duas apliquem exatamente as mesmas regras de bloqueio.
"""
from dataclasses import dataclass, field

from conferencia import Relatorio, conferir_tres
from core import Documento, brl, ler_pdf
from mensagem import mensagem_whatsapp, pendencias_antes_de_enviar

TIPOS_BANCO = ["itau", "sicoob"]
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


def validar(docs: list[Documento]) -> list[str]:
    erros = []
    contas = [d for d in docs if d.tipo == "contas"]
    bancos = [d for d in docs if d.tipo in TIPOS_BANCO]
    folhas = [d for d in docs if d.tipo == "folha"]
    desconhecidos = [d.arquivo for d in docs if d.tipo == "desconhecido"]
    if desconhecidos:
        erros.append("Layout não reconhecido: " + ", ".join(desconhecidos) + ".")
    if len(contas) != 1 or len(bancos) > 1 or len(folhas) > 1 or not (bancos or folhas):
        erros.append("Envie um contas a pagar e, da mesma empresa, os agendamentos do banco, o extrato da folha ou os dois.")
    if len({d.hash for d in docs}) != len(docs):
        erros.append("Arquivo repetido no lote.")
    if len({d.cnpj for d in docs if d.cnpj}) > 1:
        erros.append("Os arquivos são de CNPJs diferentes. Separe as empresas.")
    if any(not d.integro for d in docs):
        erros.append("Leitura incompleta ou total que não fecha: conferência bloqueada.")
    return erros


def conferir_lote(fontes: list[tuple[str, bytes]], relacoes: dict[str, str] | None = None,
                  observacoes: str = "") -> Lote:
    lote = Lote()
    if not fontes:
        lote.erros.append("Nenhum arquivo enviado.")
        return lote
    for nome, dados in fontes:
        try:
            lote.docs.append(ler_pdf(nome, dados))
        except Exception as exc:
            lote.erros.append(f"{nome}: leitura interrompida ({type(exc).__name__}). Verifique o PDF.")
    lote.erros += validar(lote.docs)
    if lote.erros:
        return lote
    por_tipo = lambda tipos: next((d for d in lote.docs if d.tipo in tipos), None)
    lote.relatorio = conferir_tres(por_tipo(["contas"]), por_tipo(TIPOS_BANCO), por_tipo(["folha"]),
                                   relacoes or {}, observacoes=observacoes)
    return lote


def resumo_documento(d: Documento) -> dict:
    return {"arquivo": d.arquivo, "tipo": NOMES_TIPO.get(d.tipo, d.tipo), "registros": len(d.itens),
            "soma_lida": brl(d.total),
            "total_impresso": brl(d.total_impresso) if d.total_impresso is not None else None,
            "validado": d.integro, "cnpj_no_cabecalho": bool(d.cnpj),
            "periodo": " a ".join(d.periodo), "alertas": d.alertas}


def para_json(lote: Lote, cliente: str = "") -> dict:
    """Resposta do agente. Não carrega evidências nem itens: só o necessário para conversar."""
    r = lote.relatorio
    saida = {"ok": r is not None, "erros": lote.erros,
             "documentos": [resumo_documento(d) for d in lote.docs]}
    if r is None:
        return saida
    avisos = []
    if any(not d.cnpj for d in lote.docs):
        avisos.append("Há relatório sem CNPJ no cabeçalho. Confirme que é da mesma empresa; o nome do arquivo não comprova.")
    saida.update({"divergencias": len(r.divergentes), "avisos": avisos,
                  "relatorio_markdown": r.markdown(),
                  "pendencias_antes_de_enviar": pendencias_antes_de_enviar(r),
                  "mensagem_whatsapp": mensagem_whatsapp(r, cliente)})
    return saida
