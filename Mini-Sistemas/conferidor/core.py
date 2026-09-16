"""Conferência local e determinística. Valores sempre em centavos; sem rede/IA."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from decimal import Decimal
from hashlib import sha256
from io import BytesIO
import re
import unicodedata
import pdfplumber

MONEY = r"\d[\d.]*,\d{2}"
DATE = r"\d{2}/\d{2}/\d{4}"


def cents(s):
    return int(Decimal(s.replace(".", "").replace(",", ".")) * 100)


def brl(n):
    return f"R$ {n / 100:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def norm(s):
    s = "".join(c for c in unicodedata.normalize("NFD", s.upper()) if not unicodedata.combining(c))
    return " ".join(re.findall(r"[A-Z0-9]+", s))


@dataclass
class Item:
    id: str
    nome: str
    valor: int
    data: str = ""
    descricao: str = ""
    categoria: str = ""
    documento: str = ""
    situacao: str = ""
    pagina: int = 1
    evidencia: str = ""


@dataclass
class Documento:
    arquivo: str
    hash: str
    tipo: str
    paginas: int
    itens: list[Item] = field(default_factory=list)
    total_impresso: int | None = None
    quantidade_impressa: int | None = None
    cnpj: str = ""
    periodo: list[str] = field(default_factory=list)
    alertas: list[str] = field(default_factory=list)

    @property
    def total(self):
        return sum(i.valor for i in self.itens)

    @property
    def integro(self):
        return bool(self.itens) and not self.alertas and self.total_impresso == self.total


def _crop(page, x0, y0, x1, y1):
    return " ".join((page.crop((x0, max(0, y0), x1, min(page.height, y1))).extract_text() or "").split())


def ler_pdf(nome: str, dados: bytes) -> Documento:
    if not dados.startswith(b"%PDF"):
        raise ValueError("O arquivo não é um PDF válido.")
    with pdfplumber.open(BytesIO(dados)) as pdf:
        textos = [p.extract_text() or "" for p in pdf.pages]
        texto = "\n".join(textos)
        tipo = ("contas" if "Relatório de Contas a Pagar" in texto else
                "folha" if "EXTRATO MENSAL" in texto and "Líquido:" in texto else
                "sicoob" if "Transações Pendentes" in texto and "SICOOB" in texto else
                "itau" if "itau.com.br" in texto and "pagamentos" in texto else "desconhecido")
        doc = Documento(nome, sha256(dados).hexdigest(), tipo, len(textos))
        if any(not t.strip() for t in textos):
            doc.alertas.append("Há página sem texto. PDF digitalizado/OCR não suportado nesta versão.")
        cab = re.search(r"(?:CNPJ:\s*|CNPJ\s+)(\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2})", textos[0] if textos else "")
        if cab:
            doc.cnpj = cab[1]
        if tipo == "contas":
            head = texto.split("*Há filtros")[0]
            cn = re.search(r"\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}", head)
            doc.cnpj = cn[0] if cn else ""
            period = re.search(f"({DATE}) a ({DATE})", head)
            doc.periodo = list(period.groups()) if period else []
            total = re.search(r"Total do Período \(R\$\) (" + MONEY + ")", head)
            doc.total_impresso = cents(total[1]) if total else None
            qt = re.search(r"De " + DATE + " a " + DATE + r" (\d+) ", texto)
            doc.quantidade_impressa = int(qt[1]) if qt else None
            for pn, page in enumerate(pdf.pages, 1):
                words = page.extract_words()
                header = next((w for w in words if w["text"] == "Vencimento"), None)
                if not header:
                    continue
                # O layout Conta Azul tem separadores horizontais por registro.
                ends = sorted(set(round(l["top"], 2) for l in page.lines
                                  if l["x0"] < 25 and l["x1"] >= 85 and abs(l["top"] - l["bottom"]) < .1))
                start = header["bottom"] + 2
                for w in words:
                    if not (w["x0"] < 30 and w["top"] > header["bottom"] and re.fullmatch(DATE, w["text"])):
                        continue
                    end = next((y for y in ends if y > w["bottom"]), None)
                    if end is None:
                        doc.alertas.append(f"Registro sem limite de linha na página {pn}.")
                        continue
                    bands = [r for r in page.rects if r["x0"] >= 751 and r["x1"] <= 822
                             and r["top"] <= w["top"] < r["bottom"]]
                    if bands:
                        start = max(start, bands[0]["top"] - 2)
                    vals = [_crop(page, a, start, b, end) for a, b in
                            [(20, 90), (90, 160), (160, 313), (313, 428), (428, 581), (581, 666), (751, 822)]]
                    if not re.fullmatch(MONEY, vals[5]):
                        doc.alertas.append(f"Valor não reconhecido na página {pn}: {vals[5]}")
                        start = end
                        continue
                    doc.itens.append(Item(str(len(doc.itens)+1), vals[3], cents(vals[5]), vals[1],
                                          vals[2], vals[4], situacao=re.sub(r"^\d+\s*", "", vals[6]), pagina=pn,
                                          evidencia=" | ".join(vals)))
                    start = end
        elif tipo == "folha":
            for pn, t in enumerate(textos, 1):
                for b in re.split(r"(?:Empr\.:|Contr:)\s*", t)[1:]:
                    n = re.match(r"(\d+)(.+?) Situação:", b)
                    v = re.search(r"Líquido: (" + MONEY + ")", b)
                    cp = re.search(r"CPF:([\d.-]+)", b)
                    if not (n and v and cp):
                        doc.alertas.append(f"Bloco de funcionário incompleto na página {pn}.")
                        continue
                    doc.itens.append(Item(str(len(doc.itens)+1), n[2].strip(), cents(v[1]), documento=cp[1], pagina=pn, evidencia="Registro: " + b.split("NF:")[0]))
            totals = re.findall(r"Líquido Geral: (" + MONEY + ")", texto)
            doc.total_impresso = cents(totals[0]) if totals else None
            if len(set(totals)) > 1:
                doc.alertas.append("Totais líquidos impressos discordam entre páginas.")
        elif tipo == "sicoob":
            # Concatenação preserva transações cortadas entre páginas.
            pattern = r"Pagamento (?:e Transferência Pix - via canal|Título \(CIP\)) (" + DATE + r") R\$ (" + MONEY + ")"
            anchors = list(re.finditer(pattern, texto))
            for idx, a in enumerate(anchors):
                b = texto[a.start():anchors[idx+1].start() if idx+1 < len(anchors) else len(texto)]
                n = re.search(r"Favorecido: (.+)", b)
                obs = re.search(r"Observação: (.+)", b)
                cp = re.search(r"CPF/CNPJ: (.+)", b)
                pn = 1
                offset = 0
                for j, t in enumerate(textos, 1):
                    if a.start() < offset + len(t) + 1:
                        pn = j
                        break
                    offset += len(t) + 1
                doc.itens.append(Item(str(idx+1), n[1] if n else "", cents(a[2]), a[1],
                                      obs[1] if obs else "", documento=cp[1] if cp else "", situacao="Pendente", pagina=pn, evidencia=b.strip()))
            v = re.search(r"Total R\$ (" + MONEY + ")", texto)
            doc.total_impresso = cents(v[1]) if v else None
        elif tipo == "itau":
            per = re.search(r"[Pp]eríodo: ("+DATE+r") [aà] ("+DATE+")", texto)
            doc.periodo = list(per.groups()) if per else []
            for pn, page in enumerate(pdf.pages, 1):
                words = page.extract_words()
                heads = [w for w in words if w["text"] == "CPF/CNPJ"]
                if not heads:
                    doc.alertas.append(f"Cabeçalho bancário não localizado na página {pn}.")
                    continue
                hy = heads[0]["top"]
                anchors = [w for w in words if re.fullmatch(DATE, w["text"]) and w["top"] > hy and w["x0"] > 300]
                for j, w in enumerate(anchors):
                    y0 = (anchors[j-1]["bottom"] + w["top"])/2 if j else hy + 10
                    y1 = (w["bottom"] + anchors[j+1]["top"])/2 if j+1 < len(anchors) else w["bottom"]+8
                    # Dois layouts Itaú: com e sem coluna referência da empresa.
                    ref = any(x["text"] == "referência" for x in words)
                    split = 137 if ref else 166
                    name = _crop(page, 48, y0, split, y1)
                    raw = _crop(page, 48, y0, page.width-40, y1)
                    cp = re.search(r"(?:\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}|\*{3}\.\d{3}\.\d{3}-\*{2})", raw)
                    line = " ".join(x["text"] for x in words if abs(x["top"]-w["top"]) < 2 and x["x0"] > w["x0"])
                    v = re.search(MONEY, line)
                    if not v:
                        doc.alertas.append(f"Valor bancário não lido na página {pn}.")
                        continue
                    doc.itens.append(Item(str(len(doc.itens)+1), name, cents(v[0]), w["text"],
                                          documento=cp[0] if cp else "", situacao="Efetuado" if "Efetuado" in raw else "Pendente de autorização", pagina=pn, evidencia=raw))
            total = re.search(r"[Tt]otal R\$ ("+MONEY+r") (\d+) pagamentos", texto)
            if total:
                doc.total_impresso, doc.quantidade_impressa = cents(total[1]), int(total[2])
        else:
            doc.alertas.append("Layout não suportado. Não foi tentada conciliação genérica.")
        if doc.total_impresso is None:
            doc.alertas.append("Total de controle não localizado.")
        elif doc.total != doc.total_impresso:
            doc.alertas.append(f"Soma extraída {brl(doc.total)} difere do total impresso {brl(doc.total_impresso)}.")
        if doc.quantidade_impressa is not None and len(doc.itens) != doc.quantidade_impressa:
            doc.alertas.append("Quantidade extraída difere da quantidade impressa.")
        return doc


def _tokens(s):
    ignore = {"DE", "DA", "DO", "DOS", "DAS", "E", "LTDA", "EIRELI", "EPP"}
    return set(norm(s).split()) - ignore


def afinidade(a: Item, b: Item, aliases: dict[str, str]):
    """Retorna evidência textual; valor sozinho nunca identifica o beneficiário."""
    dest = norm(b.nome)
    texts = [norm(a.nome), norm(a.descricao)]
    for origem, destino in aliases.items():
        if norm(origem) in texts and norm(destino) == dest:
            return "Relação cadastrada"
    if "PENSAO" in norm(a.categoria + " " + a.descricao):
        return ""  # O empregado não é necessariamente o beneficiário da pensão.
    if dest and dest in texts:
        return "Nome exato"
    ts = _tokens(b.nome or b.descricao)
    for s in [a.nome, a.descricao]:
        # Retira rótulos, nunca presume que a parcela seja a competência.
        s = re.sub(r"^.*?(?:SALARIO|BOLSA ESTAGIO|PRO LABORE)\s*", "", norm(s))
        ss = _tokens(s)
        if len(ts) >= 2 and ts <= ss:
            return "Nome contido na descrição"
        if len(ts & ss) >= 2 and len(ts & ss) / max(1, min(len(ts), len(ss))) >= .7:
            return "Nome parcial — revisar"
        if len(ss) == 1 and ss <= ts:
            return "Nome parcial — revisar"
    return ""


def conferir(origem: Documento, destino: Documento, aliases=None, aceitar_data_sicoob=False):
    aliases = aliases or {}
    if not origem.integro or not destino.integro:
        return [{"status": "Bloqueado", "motivo": "Corrija os alertas de leitura antes de conciliar."}]
    if origem.cnpj and destino.cnpj and origem.cnpj != destino.cnpj:
        return [{"status": "Bloqueado", "motivo": "Os documentos pertencem a CNPJs diferentes."}]
    candidates = {}
    for a in origem.itens:
        candidates[a.id] = [(b, afinidade(a, b, aliases)) for b in destino.itens if afinidade(a, b, aliases)]
    rows, used = [], set()
    def row(a, b, status, motivo):
        return {"status": status, "origem_id": a.id if a else "", "destino_id": b.id if b else "",
                "origem": (a.nome or a.descricao) if a else "", "descrição": a.descricao if a else "",
                "destino": (b.nome or b.descricao) if b else "", "valor_origem": a.valor if a else None,
                "valor_destino": b.valor if b else None, "diferença_centavos": b.valor-a.valor if a and b else None,
                "data_origem": a.data if a else "", "data_destino": b.data if b else "",
                "situação_destino": b.situacao if b else "", "motivo": motivo,
                "fonte_origem": f"{origem.arquivo} · p. {a.pagina}" if a else "",
                "fonte_destino": f"{destino.arquivo} · p. {b.pagina}" if b else ""}
    for a in origem.itens:
        if origem.tipo == "contas" and destino.tipo == "folha" and not any(
            k in norm(a.descricao + " " + a.categoria) for k in ["SALARIO", "BOLSA ESTAGIO", "PRO LABORE", "REMUNERACAO DE FUNCION", "REMUNERACAO FUNCION"]
        ):
            rows.append(row(a, None, "Fora do escopo da folha", "Conta não identificada como salário, bolsa ou pró-labore.")); continue
        if a.valor == 0 and origem.tipo == "folha":
            rows.append(row(a, None, "Líquido zero", "Não exige pagamento líquido neste relatório.")); continue
        cs = candidates[a.id]
        exact = [(b, ev) for b, ev in cs if b.valor == a.valor]
        chosen = exact if exact else cs
        if len(chosen) == 1:
            b, ev = chosen[0]
            competitors = [x for x in origem.itens if x.id != a.id and any(y.id == b.id and (x.valor == b.valor or not exact) for y, _ in candidates[x.id])]
            if b.id in used or competitors:
                rows.append(row(a, b, "Ambíguo", "Mesmo destino tem mais de uma origem possível.")); continue
            used.add(b.id)
            status = "Correspondência"
            reasons = [ev]
            if "revisar" in ev:
                status = "Revisar associação"
            if b.valor != a.valor:
                status = "Divergência de valor"
                reasons.append(f"Diferença de {brl(b.valor-a.valor)}; desconto não presumido.")
            if a.documento and b.documento:
                da = re.sub(r"[^0-9*]", "", a.documento)
                db = re.sub(r"[^0-9*]", "", b.documento)
                if len(da) != len(db) or any(x != y for x,y in zip(da,db) if x != "*" and y != "*"):
                    status = "Divergência de documento"
                    reasons.append("CPF/CNPJ tem dígitos incompatíveis.")
                else:
                    reasons.append("Dígitos disponíveis do CPF/CNPJ compatíveis (máscara não identifica sozinha).")
            if a.data and b.data and a.data != b.data:
                reasons.append("Datas diferentes.")
                if status in ["Correspondência", "Revisar associação"]:
                    status = "Divergência de data"
            if destino.tipo == "sicoob" and not aceitar_data_sicoob:
                reasons.append("Significado da data Sicoob ainda não validado; correspondência não confirma data de pagamento.")
                if status == "Correspondência": status = "Revisar data Sicoob"
            if b.situacao == "Efetuado" and "aberto" in a.situacao.lower():
                reasons.append("Banco efetuado; conta permanece em aberto.")
                if status == "Correspondência": status = "Divergência de situação"
            rows.append(row(a, b, status, " ".join(reasons)))
        elif len(chosen) > 1:
            rows.append(row(a, None, "Ambíguo", "Vários candidatos: " + ", ".join(b.id for b, _ in chosen)))
        else:
            status, reason = "Sem correspondência", "Não encontrado por nome/relação; não comprova falta de pagamento."
            if a.data and len(destino.periodo) == 2:
                dt = lambda s: tuple(reversed(s.split("/")))
                if not dt(destino.periodo[0]) <= dt(a.data) <= dt(destino.periodo[1]):
                    status, reason = "Fora do período", "Data fora da cobertura do relatório de destino."
            rows.append(row(a, None, status, reason))
    for b in destino.itens:
        if b.id not in used:
            rows.append(row(None, b, "Destino não conciliado", "Pode depender de relação cadastrada, agrupamento ou documento adicional."))
    return rows


def serializar(doc):
    return asdict(doc)
