"""Mensagem de envio ao cliente pelo WhatsApp, a partir do modelo em `modelos/`.

Formatação do WhatsApp: *negrito*, "- " para itens e uma linha em branco entre
os blocos. As observações são as que o operador escreveu, na ordem em que
escreveu. Divergências da conferência não entram no texto: são para corrigir
antes de enviar.
"""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

from conferencia import Relatorio

MODELO = Path(__file__).resolve().parent / "modelos" / "mensagem_whatsapp.txt"


def saudacao(agora: datetime | None = None) -> str:
    hora = (agora or datetime.now()).hour
    return "Bom dia" if hora < 12 else "Boa tarde" if hora < 18 else "Boa noite"


def _dia_mes(data: str) -> str:
    return data[:5] if data else "xx/xx"


def empresa_do_arquivo(nome_arquivo: str) -> str:
    """"L2H - CONTAS A PAGAR - 11.09 A 20.09.pdf" → "L2H". Vazio se o nome não segue o padrão."""
    m = re.match(r"^\s*([^-–_]{2,20}?)\s*[-–_]", nome_arquivo or "")
    if not m:
        return ""
    nome = m.group(1).strip()
    if re.search(r"(?i)contas|agendamento|extrato|folha|relat", nome):
        return ""
    return nome.upper()


def _limpar(texto: str) -> str:
    """Tira marcadores de lista e o ponto final duplicado; o texto é do operador."""
    return re.sub(r"^\s*[-*•·]+\s*", "", texto).strip().rstrip(".") + "."


def mensagem_whatsapp(r: Relatorio, cliente: str = "", agora: datetime | None = None,
                      modelo: str | None = None, empresa: str = "") -> str:
    modelo = modelo if modelo is not None else MODELO.read_text(encoding="utf-8")
    cliente = cliente.strip()
    cliente = cliente if cliente.startswith("@") else ("@" + cliente if cliente else "@cliente")
    # Só "@": o operador marca o contato no próprio WhatsApp, logo depois do arroba.
    cliente = cliente if cliente == "@" else cliente + "!"
    inicio, fim = (r.periodo + ["", ""])[:2]
    periodo = f"contas a pagar de {_dia_mes(inicio)} a {_dia_mes(fim)}"
    titulo = f"{empresa.strip().upper()} | {periodo[0].upper() + periodo[1:]}" if empresa.strip() else \
        periodo[0].upper() + periodo[1:]

    obs = [_limpar(o["texto"]) for o in r.observacoes]
    situacoes = {(l.banco.situacao or "").lower() for l in r.linhas if l.banco}
    if not r.tem_banco:
        situacao_banco = "Segue a conferência do período."
    elif any("pendente" in s for s in situacoes):
        situacao_banco = ("Os lançamentos do período estão agendados no banco, *aguardando sua autorização*"
                          + (", com as observações abaixo." if obs else "."))
    else:
        situacao_banco = ("Os pagamentos do período já constam como *efetuados* no banco"
                          + (", com as observações abaixo." if obs else "."))

    valores = {"saudacao": saudacao(agora), "cliente": cliente, "titulo": titulo, "situacao_banco": situacao_banco,
               "empresa": empresa.strip().upper(), "inicio": _dia_mes(inicio), "fim": _dia_mes(fim)}
    blocos: list[list[str]] = [[]]
    for linha in modelo.splitlines():
        marcador = linha.strip()
        if not marcador:
            blocos.append([])
            continue
        if marcador == "{observacoes}":
            if obs:
                blocos[-1] += ["*Observações:*"] + [f"- {o}" for o in obs]
            continue
        blocos[-1].append(linha.format(**valores))
    # Uma linha em branco entre blocos, nunca duas.
    return "\n\n".join("\n".join(b) for b in blocos if b).strip() + "\n"


def pendencias_antes_de_enviar(r: Relatorio) -> list[str]:
    """O que ainda contradiz a mensagem: divergências e observações que o banco desmente."""
    avisos = [f"{l.pessoa}: " + "; ".join(re.sub(r"\*", "", d["situacao"]) for d in l.divergencias) for l in r.divergentes]
    avisos += [f"Observação \"{o['texto']}\": {re.sub(r'[*]', '', o['efeito'])}"
               for o in r.observacoes if "atenção" in o["efeito"]]
    return avisos
