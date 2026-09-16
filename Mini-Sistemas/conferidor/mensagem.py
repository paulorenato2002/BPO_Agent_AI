"""Mensagem de envio ao cliente pelo WhatsApp, a partir do modelo em `modelos/`.

As observações são as que o operador escreveu, na ordem em que escreveu.
Divergências da conferência não entram no texto: são para corrigir antes de
enviar.
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


def mensagem_whatsapp(r: Relatorio, cliente: str = "", agora: datetime | None = None,
                      modelo: str | None = None) -> str:
    modelo = modelo if modelo is not None else MODELO.read_text(encoding="utf-8")
    cliente = cliente.strip()
    cliente = cliente if cliente.startswith("@") else ("@" + cliente if cliente else "@cliente")
    inicio, fim = (r.periodo + ["", ""])[:2]

    situacoes = {(l.banco.situacao or "").lower() for l in r.linhas if l.banco}
    if not r.tem_banco:
        situacao_banco = ""
    elif any("pendente" in s for s in situacoes):
        situacao_banco = "Os agendamentos realizados encontram-se no banco, aguardando assinatura/autorização."
    else:
        situacao_banco = "Os agendamentos realizados já constam como efetuados no banco."

    obs = [o["texto"].rstrip(".") + "." for o in r.observacoes]
    valores = {"saudacao": saudacao(agora), "cliente": cliente, "inicio": _dia_mes(inicio), "fim": _dia_mes(fim),
               "situacao_banco": situacao_banco,
               "demais": "Os demais lançamentos encontram-se agendados." if obs else "Todos os lançamentos encontram-se agendados."}
    saida = []
    for linha in modelo.splitlines():
        marcador = linha.strip()
        if marcador == "{observacoes}":
            if obs:
                saida += ["Observações:", ""] + [f"* {o}" for o in obs] + [""]
            continue
        if marcador == "{situacao_banco}" and not situacao_banco:
            continue
        saida.append(linha.format(**valores))
    return "\n".join(saida).strip() + "\n"


def pendencias_antes_de_enviar(r: Relatorio) -> list[str]:
    """O que ainda contradiz a mensagem: divergências e observações que o banco desmente."""
    avisos = [f"{l.pessoa}: " + "; ".join(re.sub(r"\*", "", d["situacao"]) for d in l.divergencias) for l in r.divergentes]
    avisos += [f"Observação \"{o['texto']}\": {re.sub(r'[*]', '', o['efeito'])}"
               for o in r.observacoes if "atenção" in o["efeito"]]
    return avisos
