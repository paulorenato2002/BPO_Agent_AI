"""Conferimento de agendamentos: contas a pagar × extrato da folha × banco.

A leitura dos PDFs fica no `core`. Aqui cada pagamento vira uma linha com o que
cada fonte diz dele, e o resultado responde o que o operador precisa saber:
bate ou não bate, quanto, e o que fazer. Sem IA; mesmos arquivos, mesmo
resultado.
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, timedelta

from core import Documento, Item, brl, norm
from fontes import BENEFICIOS, fala_de

ROTULOS_FOLHA = ("SALARIO", "BOLSA ESTAGIO", "ESTAGIARIO", "REMUNERACAO FUNCION", "REMUNERACAO DE FUNCION",
                 "PRO LABORE", "PENSAO", "FERIAS", "RESCISAO", "EXTRA FOLHA")

# Palavras que descrevem o lançamento, não quem recebe.
PALAVRAS_ROTULO = {
    "SALARIO", "SALARIOS", "BOLSA", "ESTAGIO", "ESTAGIARIO", "ESTAGIARIOS", "PRO", "LABORE", "COMPLEMENTO",
    "DISTRIBUICAO", "LUCRO", "LUCROS", "DEVOLUCAO", "DEVOLUCOES", "APORTE", "APORTES", "EXTRA", "FOLHA",
    "PENSAO", "ALIMENTICIA", "REFERENTE", "PARCELA", "PAGAMENTO", "REMUNERACAO", "FUNCIONARIO",
    "FUNCIONARIOS", "FERIAS", "RESCISAO", "ADIANTAMENTO", "VALE", "BOLETO", "PIX", "TED", "NF",
    "LTDA", "ME", "EPP", "EIRELI", "SA", "S", "A", "DE", "DA", "DO", "DOS", "DAS", "E", "EM",
}

RE_PESSOA = re.compile(
    r"^\s*(?:\d+\s*/\s*\d+\s*-?\s*)?(?:complemento\s+de\s+)?"
    r"(?:sal[áa]rios?|bolsa[\s-]*est[áa]gio|pr[óo][\s-]*labore|pens[ãa]o(?:\s+aliment[íi]c[íi]a)?|f[ée]rias|rescis[ãa]o)"
    r"\s*-?\s*(.+)$",
    re.I,
)

# Guias da folha (INSS, FGTS...) são pagas ao governo, não às pessoas.
ROTULOS_ENCARGOS = ("INSS", "FGTS", "IRRF", "GPS", "DARF", "DCTFWEB", "CONTRIBUICAO SINDICAL", "SINDICATO")

# Salários, pró-labore e afins são pagos do dia 28 ao dia 8.
DIA_FOLHA_INICIO, DIA_FOLHA_FIM = 28, 8

# Categoria do contas a pagar → como o favorecido aparece no banco (só com o mesmo valor).
DICAS_FAVORECIDO = (
    (("FGTS",), ("CAIXA", "FGTS")),
    (("INSS", "GPS", "DARF", "IRRF", "IRPJ", "CSLL", "PIS", "COFINS", "SIMPLES NACIONAL", "DAS", "DCTFWEB",
      "RECEITA FEDERAL", "IMPOSTO DE RENDA"),
     ("RECEITA", "DARF", "FAZENDA NACIONAL", "INSS", "SIMPLES", "DAS", "GPS")),
    (("IPTU", "ISS", "ISSQN", "TFE", "TLF", "ALVARA"), ("PREFEITURA", "MUNICIPIO", "SEFIN", "SEFAZ", "GDF")),
    (("ICMS", "IPVA", "DETRAN", "LICENCIAMENTO", "DIFAL"), ("SEFAZ", "SECRETARIA", "FAZENDA", "DETRAN", "GDF")),
)

CONFIANCA_POR_VALOR = 40
BONUS_MESMO_VALOR = 25


# ------------------------------------------------------------------ identificação

def eh_encargo(item: Item) -> bool:
    texto = f" {norm(item.categoria + ' ' + item.descricao)} "
    return any(f" {r} " in texto for r in ROTULOS_ENCARGOS)


def eh_folha(item: Item) -> bool:
    texto = norm(item.categoria + " " + item.descricao)
    return any(r in texto for r in ROTULOS_FOLHA) and not eh_encargo(item)


def na_janela_folha(data: str) -> bool:
    d = _data(data)
    return d is None or d.day >= DIA_FOLHA_INICIO or d.day <= DIA_FOLHA_FIM


def eh_folha_do_periodo(item: Item) -> bool:
    """Lançamento de folha com vencimento em dia de folha. Fora disso é pagamento comum."""
    return eh_folha(item) and na_janela_folha(item.data)


def periodo_tem_folha(periodo: list[str]) -> bool:
    """O período (início, fim) inclui algum dia de pagamento da folha? Sem período, sim."""
    a, b = (_data(x) for x in (list(periodo) + ["", ""])[:2])
    if not a or not b or b < a:
        return True
    if (b - a).days >= 31:
        return True
    return any(na_janela_folha((a + timedelta(days=n)).strftime("%d/%m/%Y")) for n in range((b - a).days + 1))


ROTULOS_SOCIO = ("DISTRIBUICAO DE LUCRO", "DEVOLUCAO DE APORTE", "DEVOLUCOES DE APORTE")


def eh_de_pessoa(item: Item) -> bool:
    """Lançamentos cujo recebedor está na descrição, não no fornecedor."""
    texto = norm(item.categoria + " " + item.descricao)
    return eh_folha(item) or any(r in texto for r in ROTULOS_SOCIO)


def eh_pensao(item: Item) -> bool:
    return "PENSAO" in norm(item.categoria + " " + item.descricao)


def tokens(nome: str) -> set[str]:
    return {t for t in norm(nome or "").split() if t not in PALAVRAS_ROTULO and not t.isdigit()}


def pessoa_da_descricao(item: Item) -> str:
    m = RE_PESSOA.match(item.descricao or "")
    if m:
        return m.group(1).strip(" -")
    return re.sub(r"^\s*\d+\s*/\s*\d+\s*-\s*", "", item.descricao or "").strip()


def fornecedores_proprios(itens: list[Item]) -> set[str]:
    """No Conta Azul a folha costuma ter a própria empresa como fornecedor."""
    contagem = Counter(norm(i.nome) for i in itens if i.nome and eh_de_pessoa(i))
    return {n for n, q in contagem.items() if q >= 3}


def nome_no_banco(item: Item, proprios: set[str]) -> str:
    """Quem deve aparecer como favorecido no banco."""
    fornecedor = item.nome if item.nome and norm(item.nome) not in proprios else ""
    if eh_pensao(item):
        return fornecedor                     # a beneficiária, nunca o funcionário
    if eh_de_pessoa(item):
        return pessoa_da_descricao(item) or fornecedor
    return fornecedor or pessoa_da_descricao(item)


def descricao_limpa(item: Item) -> str:
    """Descrição sem o número da parcela ("9/12 - ")."""
    return re.sub(r"^\s*\d+\s*/\s*\d+\s*-\s*", "", item.descricao or "").strip()


def nome_do_banco(item: Item) -> str:
    return item.nome or item.descricao        # boletos do Sicoob trazem o nome na observação


def cpf_compativel(a: str, b: str) -> bool | None:
    """None quando não dá para comparar; máscaras (***) são ignoradas posição a posição."""
    da, db = re.sub(r"[^0-9*]", "", a or ""), re.sub(r"[^0-9*]", "", b or "")
    if not da or not db or len(da) != len(db):
        return None
    pares = [(x, y) for x, y in zip(da, db) if x != "*" and y != "*"]
    if len(pares) < 6:
        return None
    return all(x == y for x, y in pares)


@dataclass
class Ref:
    chave: str
    item: Item
    nome: str
    documento: str = ""
    descricao: str = ""

    def __post_init__(self):
        self.documento = self.documento or self.item.documento


def _igual(x: str, y: str) -> bool:
    # O banco abrevia ("MERCADO CENT" = "MERCADO CENTRAL").
    return x == y or (min(len(x), len(y)) >= 3 and (x.startswith(y) or y.startswith(x)))


def _contido(p: set[str], q: set[str]) -> bool:
    return all(any(_igual(x, y) for y in q) for x in p)


def pontuar(a: Ref, b: Ref, relacionado: bool) -> int:
    if relacionado:
        return 100
    if cpf_compativel(a.documento, b.documento) is False:
        return 0
    return max(_pontuar_nome(a, b), _pontuar_descricao(a, b), _pontuar_categoria(a, b))


def _pontuar_categoria(a: Ref, b: Ref) -> int:
    """Guia paga a outro favorecido (FGTS à Caixa, INSS à Receita): categoria + mesmo valor."""
    if a.item.valor != b.item.valor:
        return 0
    texto = f" {norm(' '.join((a.item.categoria, a.item.descricao, a.item.nome)))} "
    favorecido = f" {norm(b.nome)} "
    for chaves, favorecidos in DICAS_FAVORECIDO:
        if any(f" {c} " in texto for c in chaves) and any(f" {f} " in favorecido for f in favorecidos):
            return 75
    return 0


def _pontuar_descricao(a: Ref, b: Ref) -> int:
    """Descrição do contas a pagar × observação do banco (boletos do Sicoob não têm favorecido)."""
    if not a.descricao or not b.descricao or a.item.valor != b.item.valor:
        return 0
    ta, tb = tokens(a.descricao), tokens(b.descricao)
    if min(len(ta), len(tb)) < 2:
        return 0
    if ta == tb:
        return 85
    if _contido(ta, tb) or _contido(tb, ta):
        return 75
    return 0


def _pontuar_nome(a: Ref, b: Ref) -> int:
    cpf = cpf_compativel(a.documento, b.documento)
    ta, tb = tokens(a.nome), tokens(b.nome)
    comum = {x for x in ta if any(_igual(x, y) for y in tb)}
    if not comum:
        return 0
    if cpf:
        return 90
    if ta == tb:
        return 80
    menor = min(len(ta), len(tb))
    if _contido(ta, tb) or _contido(tb, ta):
        if menor >= 2:
            return 70
        # Um nome só ("TRANSPORTADORA", "FULANO") só vale com o mesmo valor.
        if max(len(t) for t in comum) >= 4 and a.item.valor == b.item.valor:
            return 60
    if len(comum) >= 2 and len(comum) / menor >= 0.6:
        return 50
    return 0


def _data(s: str) -> date | None:
    try:
        d, m, a = (int(x) for x in s.split("/"))
        return date(a, m, d)
    except (ValueError, AttributeError):
        return None


def casar(origens: list[Ref], destinos: list[Ref], relacoes: dict[str, str],
          por_valor: bool = False, usar_datas: bool = True) -> dict[str, tuple[Ref, int]]:
    """Um para um, do par mais confiável para o menos; valor igual desempata.

    `por_valor` junta o que sobrou quando o valor é único dos dois lados (e as
    datas são próximas, se forem confiáveis): nomes diferentes (razão social ×
    nome fantasia, sócio × empresa do sócio) viram um ponto para confirmar em vez
    de duas divergências falsas. Um par assim ensina a relação entre os dois
    nomes, que vale para os outros pagamentos de mesmo valor entre eles.
    """
    rel = {norm(k): norm(v) for k, v in relacoes.items()}
    pares = []
    for a in origens:
        for b in destinos:
            relacionado = norm(b.nome) in (rel.get(norm(a.nome)), rel.get(norm(a.item.descricao)))
            s = pontuar(a, b, relacionado)
            if s:
                pares.append((s + (BONUS_MESMO_VALOR if a.item.valor == b.item.valor else 0), s, a, b))
    # O valor igual pesa: um nome parecido com outro valor não tira o par exato de ninguém.
    pares.sort(key=lambda p: -p[0])
    usados_a, usados_b, res = set(), set(), {}
    for _, s, a, b in pares:
        if a.chave in usados_a or b.chave in usados_b:
            continue
        res[a.chave] = (b, s)
        usados_a.add(a.chave)
        usados_b.add(b.chave)

    if por_valor:
        _trocar_complementos(res, origens, destinos)
        usados_a = set(res)
        usados_b = {b.chave for b, _ in res.values()}

        def unir(a, b):
            res[a.chave] = (b, CONFIANCA_POR_VALOR)
            usados_a.add(a.chave)
            usados_b.add(b.chave)

        resto_a = [a for a in origens if a.chave not in usados_a]
        resto_b = [b for b in destinos if b.chave not in usados_b]
        va, vb = Counter(a.item.valor for a in resto_a), Counter(b.item.valor for b in resto_b)
        aprendidos = set()
        for a in resto_a:
            if va[a.item.valor] != 1 or vb[a.item.valor] != 1:
                continue
            b = next(x for x in resto_b if x.item.valor == a.item.valor)
            if cpf_compativel(a.documento, b.documento) is False:
                continue
            da, db = _data(a.item.data), _data(b.item.data)
            if usar_datas and da and db and not -30 <= (db - da).days <= 5:
                continue
            unir(a, b)
            aprendidos.add((frozenset(tokens(a.nome)), frozenset(tokens(b.nome))))
        mudou = True
        while mudou:
            mudou = False
            for a in origens:
                if a.chave in usados_a:
                    continue
                b = next((x for x in destinos if x.chave not in usados_b and x.item.valor == a.item.valor
                          and (frozenset(tokens(a.nome)), frozenset(tokens(x.nome))) in aprendidos), None)
                if b:
                    unir(a, b)
                    mudou = True
    return res


def _trocar_complementos(res: dict[str, tuple[Ref, int]], origens: list[Ref], destinos: list[Ref]) -> None:
    """Par com valores diferentes cujo "complemento" sobrou dos dois lados.

    Ex.: o FGTS (fornecedor "Receita Federal") casado pelo nome com o DARF do
    INSS, enquanto sobram o PIX à Caixa com o valor do FGTS e o INSS com o valor
    do DARF. Trocar fecha os dois pelo valor exato em vez de mostrar três
    divergências.
    """
    usados_b = {b.chave for b, _ in res.values()}
    livres_a = [a for a in origens if a.chave not in res]
    livres_b = [b for b in destinos if b.chave not in usados_b]
    for a in origens:
        if a.chave not in res:
            continue
        b, _ = res[a.chave]
        if a.item.valor == b.item.valor:
            continue
        b2 = next((x for x in livres_b if x.item.valor == a.item.valor
                   and cpf_compativel(a.documento, x.documento) is not False), None)
        a2 = next((x for x in livres_a if x.item.valor == b.item.valor
                   and cpf_compativel(x.documento, b.documento) is not False), None)
        if not (a2 and b2):
            continue
        res[a.chave] = (b2, pontuar(a, b2, False) or CONFIANCA_POR_VALOR)
        res[a2.chave] = (b, pontuar(a2, b, False) or CONFIANCA_POR_VALOR)
        livres_a.remove(a2)
        livres_b.remove(b2)


def agrupar(contas: list[Ref], banco: list[Ref]) -> list[tuple[list[Ref], list[Ref]]]:
    """Lançamento com vários beneficiários ("ANA / BRUNO") × um agendamento por pessoa.

    Só aceita quando os nomes batem e a soma fecha exatamente; a divisão entre
    as pessoas pode ser diferente e vira ponto para confirmar.
    """
    grupos, usados = [], set()
    multiplos = {}
    for a in contas:
        if "/" in a.nome:
            multiplos.setdefault(frozenset(tokens(a.nome)), []).append(a)
    for chave, lancamentos in multiplos.items():
        pessoas = [tokens(p) for p in lancamentos[0].nome.split("/")]
        if len(pessoas) < 2 or not all(pessoas):
            continue
        agendados = [b for b in banco if b.chave not in usados and any(p & tokens(b.nome) for p in pessoas)]
        if agendados and sum(a.item.valor for a in lancamentos) == sum(b.item.valor for b in agendados):
            grupos.append((lancamentos, agendados))
            usados.update(b.chave for b in agendados)
    return grupos


# ------------------------------------------------------------------ resultado

@dataclass
class Linha:
    pessoa: str
    conta: Item | None = None
    folha: Item | None = None
    banco: Item | None = None
    de_folha: bool = False
    fora_do_periodo: bool = False
    confianca: int = 100
    nome_conta: str = ""
    em_grupo: bool = False
    debito_automatico: bool = False
    banco_grupo: list[Item] = field(default_factory=list)
    divergencias: list[dict] = field(default_factory=list)
    avisos: list[str] = field(default_factory=list)
    justificativa: str = ""
    # Planilha/lista (VT, VA...): o item dela, ou a soma quando a comparação é pelo total.
    lista: Item | None = None
    rotulo_lista: str = ""
    soma_lista: int | None = None
    soma_contas: int | None = None
    ja_pago: bool = False

    @property
    def confere(self) -> bool:
        return not self.divergencias


@dataclass
class Relatorio:
    tem_folha: bool
    tem_banco: bool
    banco_cobre_folha: bool
    linhas: list[Linha]
    fechamento: list[tuple[str, int | None, int | None, int | None]]
    explicacao: list[str]
    pontos: list[str]
    acoes: list[str]
    observacoes: list[dict] = field(default_factory=list)
    folha_em_apuracao: bool = False
    periodo: list[str] = field(default_factory=list)
    listas: list[dict] = field(default_factory=list)
    folha_fora_do_periodo: bool = False

    @property
    def divergentes(self) -> list[Linha]:
        return [l for l in self.linhas if l.divergencias]

    @property
    def conferem(self) -> list[Linha]:
        return [l for l in self.linhas if not l.divergencias and not l.ja_pago and (l.conta or l.folha or l.lista)]

    @property
    def tem_lista(self) -> bool:
        return bool(self.listas)

    def markdown(self) -> str:
        return renderizar(self)


def conferir_tres(contas: Documento, banco: Documento | None = None, folha: Documento | None = None,
                  relacoes: dict[str, str] | None = None, aceitar_data_sicoob: bool = True,
                  observacoes: str = "", listas: list[Documento] | None = None) -> Relatorio:
    """Sem banco: só entram as contas de folha e as das listas (as demais são desconsideradas).

    A folha só é conferida quando o período do contas a pagar inclui dia de
    pagamento dela (dia 28 ao dia 8).
    """
    relacoes = relacoes or {}
    listas = listas or []
    if not (banco or folha or listas):
        raise ValueError("Envie os agendamentos do banco, o extrato da folha ou uma planilha/lista.")

    folha_fora = bool(folha) and bool(contas.periodo) and not periodo_tem_folha(contas.periodo)
    if folha_fora:
        folha = None

    proprios = fornecedores_proprios(contas.itens)

    def entra(i: Item) -> bool:
        if banco:
            return True
        if folha and eh_folha_do_periodo(i):
            return True
        return any(not l.rotulo or fala_de(l.rotulo, i) for l in listas)

    contas_itens = [i for i in contas.itens if entra(i)]
    periodo = [_data(x) for x in banco.periodo] if banco and len(banco.periodo) == 2 else None

    m_cf = {}
    if folha:
        # A pensão não é linha própria no extrato: fica fora deste cruzamento.
        m_cf = casar([Ref(i.id, i, pessoa_da_descricao(i) or i.nome) for i in contas_itens
                      if eh_folha_do_periodo(i) and not eh_pensao(i)],
                     [Ref(i.id, i, i.nome) for i in folha.itens if i.valor > 0], relacoes)
    datas_ok = banco is not None and (banco.tipo != "sicoob" or aceitar_data_sicoob)
    m_cb, grupos = {}, []
    if banco:
        cpf_da_folha = {k: f.item.documento for k, (f, _) in m_cf.items()}
        refs_c = [Ref(i.id, i, nome_no_banco(i, proprios), cpf_da_folha.get(i.id, ""), descricao_limpa(i)) for i in contas_itens]
        refs_b = [Ref(i.id, i, nome_do_banco(i), descricao=i.descricao) for i in banco.itens]
        m_cb = casar(refs_c, refs_b, relacoes, por_valor=True, usar_datas=datas_ok)
        casados_b = {b.chave for b, _ in m_cb.values()}
        grupos = agrupar([r for r in refs_c if r.chave not in m_cb], [r for r in refs_b if r.chave not in casados_b])
    em_grupo = {a.chave: (lanc, ag) for lanc, ag in grupos for a in lanc}
    banco_em_grupo = {b.chave for _, ag in grupos for b in ag}
    m_fb = {}
    if folha and banco:
        # A folha tem CPF completo; o banco, mascarado. Só o que sobrou dos outros cruzamentos.
        folha_casada = {f.chave for f, _ in m_cf.values()}
        banco_casado = {b.chave for b, _ in m_cb.values()} | banco_em_grupo
        m_fb = casar([Ref(i.id, i, i.nome) for i in folha.itens if i.valor > 0 and i.id not in folha_casada],
                     [Ref(i.id, i, nome_do_banco(i)) for i in banco.itens if i.id not in banco_casado], relacoes)

    linhas: list[Linha] = []
    for c in contas_itens:
        f, b = m_cf.get(c.id), m_cb.get(c.id)
        nome_conta = nome_no_banco(c, proprios) or pessoa_da_descricao(c) or c.nome
        pessoa = (f[0].item.nome if f else None) or (nome_do_banco(b[0].item) if b and not eh_pensao(c) else None) or nome_conta
        d = _data(c.data)
        fora = bool(periodo and d and all(periodo) and not (periodo[0] <= d <= periodo[1]))
        linha = Linha(pessoa, c, f[0].item if f else None, b[0].item if b else None,
                      de_folha=bool(folha or banco) and eh_folha_do_periodo(c),
                      fora_do_periodo=fora, confianca=min([x[1] for x in (f, b) if x] or [100]), nome_conta=nome_conta)
        if b and b[1] == CONFIANCA_POR_VALOR and not eh_pensao(c):
            banco_b = b[0].item
            no_banco = (f"favorecido **{banco_b.nome}**" if banco_b.nome else "sem favorecido")
            no_banco += f", observação **{banco_b.descricao}**" if banco_b.descricao else ""
            linha.avisos.append(f"Associado só pelo valor ({brl(c.valor)}): no contas a pagar, fornecedor **{c.nome or '—'}** "
                                f"e descrição **{descricao_limpa(c) or '—'}**; no banco, {no_banco}. "
                                "Nome e descrição não coincidem: confirme se é o mesmo pagamento.")
        if c.id in em_grupo:
            linha.em_grupo = True
            lanc, ag = em_grupo[c.id]
            if lanc[0].chave == c.id:
                linha.banco_grupo = [b.item for b in ag]
                linha.avisos.append(
                    f"**Pagamento conjunto — {nome_conta}:** no contas a pagar {len(lanc)} lançamento(s) somando "
                    f"{brl(sum(a.item.valor for a in lanc))}; no banco "
                    + ", ".join(f"{nome_do_banco(b.item)} ({brl(b.item.valor)})" for b in ag)
                    + ". A soma confere, a divisão entre as pessoas é diferente: confirme.")
        linha.debito_automatico = "DEBITO AUTOMATICO" in norm(c.nome + " " + c.descricao)
        linhas.append(linha)
    folha_usada = {l.folha.id for l in linhas if l.folha}
    banco_usado = {l.banco.id for l in linhas if l.banco} | banco_em_grupo
    if folha:
        for f in folha.itens:
            if f.id in folha_usada or f.valor == 0:
                continue
            b = m_fb.get(f.id)
            linhas.append(Linha(f.nome, None, f, b[0].item if b else None, de_folha=True, confianca=b[1] if b else 100))
            if b:
                banco_usado.add(b[0].item.id)
    if banco:
        for b in banco.itens:
            if b.id not in banco_usado:
                linhas.append(Linha(nome_do_banco(b), None, None, b))

    folha_no_banco = any(l.banco for l in linhas if l.de_folha and not (l.conta and eh_pensao(l.conta)))
    # Mesmo nome da folha no banco, barrado por CPF: o banco cobre a folha, e o CPF vira aviso.
    pessoas_folha = [(l, tokens(l.pessoa)) for l in linhas if l.de_folha and not l.banco and not (l.conta and eh_pensao(l.conta))]
    for l in linhas:
        if l.banco and not l.conta and not l.folha:
            for p, tp in pessoas_folha:
                if len(tp & tokens(nome_do_banco(l.banco))) >= 2:
                    folha_no_banco = True
                    doc_p = (p.folha.documento if p.folha else "")
                    if cpf_compativel(doc_p, l.banco.documento) is False:
                        l.avisos.append(f"**{nome_do_banco(l.banco)}**: nome igual ao de **{p.pessoa}** da folha, mas o CPF é diferente. "
                                        "Confira o favorecido antes de liberar.")
    tem_folha_a_pagar = any(l.de_folha for l in linhas)
    banco_cobre_folha = bool(banco) and (folha_no_banco or not tem_folha_a_pagar)

    resumos = [_conferir_lista(lista, linhas, proprios, relacoes) for lista in listas]

    lidas, folha_em_apuracao = _ler_observacoes(observacoes, linhas)
    cobre = banco_cobre_folha and not folha_em_apuracao
    for l in linhas:
        _classificar(l, folha is not None, banco is not None, cobre, datas_ok)
    _efeito_observacoes(lidas, linhas, folha_em_apuracao)

    pontos = _pontos(linhas, banco, folha, proprios, banco_cobre_folha or folha_em_apuracao, datas_ok)
    if folha_fora:
        pontos.insert(0, f"O extrato da folha não entrou: o período do contas a pagar ({' a '.join(contas.periodo)}) "
                         f"não inclui dia de pagamento da folha (dia {DIA_FOLHA_INICIO} ao dia {DIA_FOLHA_FIM:02d}).")
    return Relatorio(folha is not None, banco is not None, banco_cobre_folha, linhas,
                     _fechamento(linhas, banco, folha, cobre),
                     _explicacao(linhas, banco, cobre),
                     pontos,
                     _acoes(linhas, contas, banco, folha), lidas, folha_em_apuracao, contas.periodo,
                     resumos, folha_fora)


# ------------------------------------------------------------------ planilhas e listas

NOMES_ROTULO = {"VT": "vale-transporte", "VA": "vale-alimentação", "VR": "vale-refeição"}


def nome_da_lista(rotulo: str) -> str:
    return f"planilha de {rotulo}" if rotulo else "lista enviada"


def _pessoa_do_beneficio(item: Item, proprios: set[str]) -> str:
    """ "VT - FULANO" vira FULANO; sem nome na descrição, o fornecedor (se não for a própria empresa)."""
    texto = f" {norm(descricao_limpa(item))} "
    for chaves in BENEFICIOS.values():
        for c in chaves:
            texto = texto.replace(f" {c} ", " ")
    if tokens(texto):
        return texto.strip()
    return item.nome if item.nome and norm(item.nome) not in proprios else ""


def _conferir_lista(lista: Documento, linhas: list[Linha], proprios: set[str], relacoes: dict[str, str]) -> dict:
    """Planilha de VT/VA (ou lista colada) × contas a pagar.

    Pessoa a pessoa quando o contas a pagar tem um lançamento por pessoa; pelo
    total quando o benefício é pago numa conta só (a operadora). Lista sem
    rótulo é comparada com todas as contas, pessoa a pessoa.
    """
    rot = lista.rotulo
    alvo = [l for l in linhas if l.conta and (fala_de(rot, l.conta) if rot else True)]
    nome = nome_da_lista(rot)
    resumo = {"rotulo": rot, "arquivo": lista.arquivo, "itens": len(lista.itens), "total": lista.total,
              "contas": len(alvo), "soma_contas": sum(l.conta.valor for l in alvo)}
    refs_c = [Ref(str(k), l.conta, (_pessoa_do_beneficio(l.conta, proprios) if rot else l.nome_conta),
                  descricao=descricao_limpa(l.conta)) for k, l in enumerate(alvo)]
    m = casar([Ref(i.id, i, i.nome) for i in lista.itens], refs_c, relacoes)
    por_pessoa = not rot or (len(m) >= 1 and 2 * len(m) >= len(lista.itens))

    if por_pessoa:
        resumo["modo"] = "pessoa"
        casadas = set()
        for item in lista.itens:
            par = m.get(item.id)
            if not par:
                if not rot:
                    nova = Linha(item.nome, lista=item)
                    nova.divergencias.append({
                        "tipo": "lista_sem_conta", "diferenca": item.valor,
                        "situacao": f"Na {nome}, sem conta a pagar",
                        "acao": f"lançar **{item.nome}** no contas a pagar com **{brl(item.valor)}**, "
                                "ou confirmar se já foi pago"})
                    linhas.append(nova)
                    continue
                nova = Linha(item.nome, lista=item, rotulo_lista=rot)
                nova.divergencias.append({
                    "tipo": "lista_sem_conta", "diferenca": item.valor,
                    "situacao": f"Na {nome}, sem conta a pagar",
                    "acao": f"lançar o {rot} de **{item.nome}** no contas a pagar com **{brl(item.valor)}**"})
                linhas.append(nova)
                continue
            l = alvo[int(par[0].chave)]
            casadas.add(id(l))
            l.lista, l.rotulo_lista = item, rot
            if l.conta.valor != item.valor:
                d = item.valor - l.conta.valor
                l.divergencias.append({
                    "tipo": "valor_lista", "diferenca": d,
                    "situacao": f"**{brl(abs(d))} a {'menor' if d > 0 else 'maior'}** no contas a pagar que na {nome}",
                    "acao": f"corrigir o contas a pagar de **{l.pessoa}** de {brl(l.conta.valor)} para "
                            f"**{brl(item.valor)}**, ou a {nome}"})
            elif par[1] in (CONFIANCA_POR_VALOR, 50):
                l.avisos.append(f"**{l.pessoa}**: associado a **{item.nome}** da {nome} por nome parcial. Confirme.")
        if rot:
            for l in alvo:
                if id(l) not in casadas:
                    l.rotulo_lista = rot
                    l.divergencias.append({
                        "tipo": "conta_sem_lista", "diferenca": -l.conta.valor,
                        "situacao": f"Lançamento de {rot} que não está na {nome}",
                        "acao": f"conferir o {rot} de **{l.pessoa}** ({brl(l.conta.valor)}): não está na {nome}"})
        resumo["conferem"] = sum(1 for i in lista.itens if i.id in m
                                 and alvo[int(m[i.id][0].chave)].conta.valor == i.valor)
        return resumo

    resumo["modo"] = "total"
    for l in alvo:
        l.rotulo_lista = rot
    if lista.total == resumo["soma_contas"]:
        return resumo
    linha = Linha(f"{rot} — total da {nome}", rotulo_lista=rot, soma_lista=lista.total,
                  soma_contas=resumo["soma_contas"] if alvo else None)
    d = lista.total - resumo["soma_contas"]
    if alvo:
        linha.divergencias.append({
            "tipo": "total_lista", "diferenca": d,
            "situacao": f"Contas a pagar **{brl(abs(d))} a {'menor' if d > 0 else 'maior'}** que a {nome}",
            "acao": f"ajustar o {NOMES_ROTULO.get(rot, rot)} no contas a pagar de {brl(resumo['soma_contas'])} "
                    f"para **{brl(lista.total)}**, ou corrigir a {nome}"})
    else:
        linha.divergencias.append({
            "tipo": "lista_sem_conta", "diferenca": lista.total,
            "situacao": f"Nenhum lançamento de {rot} no contas a pagar",
            "acao": f"lançar o {NOMES_ROTULO.get(rot, rot)} de **{brl(lista.total)}** no contas a pagar"})
    linhas.append(linha)
    return resumo


# ------------------------------------------------------------------ observações do operador

PALAVRAS_OBSERVACAO = PALAVRAS_ROTULO | {
    "AINDA", "NAO", "RECEBIDO", "RECEBIDA", "GERADO", "GERADA", "ENCONTRA", "ENCONTRAM", "SE", "O", "OS", "AS",
    "PARA", "COM", "SEM", "POR", "QUE", "JA", "FOI", "SERA", "ESTA", "ESTAO", "AGENDADO", "AGENDADA", "AGENDAR",
    "AGENDAMENTO", "AGENDAMENTOS", "PAGO", "PAGA", "PAGAR", "CONTA", "CONTAS", "VALOR", "CLIENTE", "ENVIADO",
    "ENVIAR", "NOTA", "FISCAL", "MES", "PERIODO", "APURACAO", "FECHAMENTO", "PENDENTE", "AGUARDANDO", "ESTAGIOS",
    "FALTA", "FALTOU", "ESSE", "ESSA", "ESTE", "ESTA", "AQUI", "LANCAMENTO", "LANCAMENTOS", "BANCO", "SEMANA",
}
NEGATIVAS = {"NAO", "AINDA", "PENDENTE", "AGUARDANDO", "SEM", "FALTA", "FALTOU"}
RE_FOLHA_PENDENTE = re.compile(r"(FOLHA|SALARIOS).*(APURACAO|FECHAMENTO|CALCULO|PENDENTE|PROCESSAMENTO|ABERT)"
                               r"|(APURACAO|FECHAMENTO|CALCULO|PROCESSAMENTO).*(FOLHA|SALARIOS)")


def _ler_observacoes(texto: str, linhas: list[Linha]) -> tuple[list[dict], bool]:
    """Cada linha do operador vira uma observação com o que ela muda na conferência.

    Regras fixas e visíveis: citar a folha em apuração tira os salários da
    cobrança dos agendamentos; citar um favorecido que não foi agendado justifica
    a ausência. O efeito de cada linha aparece no resultado.
    """
    lidas, folha_pendente = [], False
    for bruta in (texto or "").splitlines():
        frase = re.sub(r"^\s*[-*•·]+\s*", "", bruta).strip()
        if not frase:
            continue
        n = norm(frase)
        obs = {"texto": frase, "efeito": "", "linhas": [], "folha": bool(RE_FOLHA_PENDENTE.search(n)),
               "negativa": bool(set(n.split()) & NEGATIVAS)}
        folha_pendente = folha_pendente or obs["folha"]
        chaves = {t for t in tokens(frase) if len(t) >= 4 and t not in PALAVRAS_OBSERVACAO}
        if chaves:
            for i, l in enumerate(linhas):
                if not l.conta:
                    continue
                nomes = tokens(l.nome_conta) | tokens(l.conta.nome) | tokens(descricao_limpa(l.conta))
                if any(_igual(x, y) for x in chaves for y in nomes):
                    obs["linhas"].append(i)
                    if not l.banco and (obs["negativa"] or not l.justificativa):
                        l.justificativa = frase
        lidas.append(obs)
    return lidas, folha_pendente


def _efeito_observacoes(lidas: list[dict], linhas: list[Linha], folha_pendente: bool) -> None:
    for obs in lidas:
        efeitos = []
        if obs["folha"]:
            n = sum(1 for l in linhas if l.de_folha and l.conta and not l.banco)
            efeitos.append(f"folha em apuração: {n} lançamento(s) de folha sem agendamento não foram cobrados" if n
                           else "folha em apuração, mas todos os lançamentos de folha já estão agendados")
        for i in obs.pop("linhas"):
            l = linhas[i]
            if l.banco and obs["negativa"]:
                efeitos.append(f"**atenção:** {l.nome_conta} aparece agendado no banco ({brl(l.banco.valor)})")
            elif l.banco:
                efeitos.append(f"relacionada a {l.nome_conta}, que está agendado")
            elif l.justificativa:
                efeitos.append(f"justifica {l.nome_conta} ({brl(l.conta.valor)}) sem agendamento")
        obs["efeito"] = "; ".join(efeitos) or "não citou nenhum lançamento; vai só na mensagem"
        obs.pop("negativa")



def _classificar(l: Linha, tem_folha: bool, tem_banco: bool, banco_cobre_folha: bool, datas_ok: bool) -> None:
    c, f, b = l.conta, l.folha, l.banco
    div = l.divergencias
    if c and f and c.valor != f.valor:
        d = f.valor - c.valor
        div.append({"tipo": "valor_folha", "diferenca": d,
                    "situacao": f"**{brl(abs(d))} a {'menor' if d > 0 else 'maior'}** no contas a pagar",
                    "acao": f"corrigir o contas a pagar de **{l.pessoa}** de {brl(c.valor)} para **{brl(f.valor)}**"})
    if tem_folha and f and not c:
        div.append({"tipo": "folha_sem_conta", "diferenca": f.valor,
                    "situacao": "Na folha, sem conta a pagar" + (" (mas agendado)" if b else ""),
                    "acao": f"lançar **{l.pessoa}** no contas a pagar com **{brl(f.valor)}**"})
    if not tem_banco:
        return
    if c and b and c.valor != b.valor:
        d = b.valor - c.valor
        pct = -d / c.valor * 100 if c.valor else 0
        if d < 0 and 1 <= round(pct) <= 15 and abs(pct - round(pct)) < 0.05:
            l.avisos.append(f"**{l.pessoa}**: agendado {brl(b.valor)}, {brl(-d)} ({round(pct)}%) abaixo do contas a pagar "
                            f"({brl(c.valor)}). Parece desconto; confirme e ajuste o valor no Conta Azul.")
        else:
            div.append({"tipo": "valor_banco", "diferenca": d,
                        "situacao": f"Agendado **{brl(abs(d))} a {'mais' if d > 0 else 'menos'}**",
                        "acao": f"ajustar o agendamento de **{l.pessoa}** de {brl(b.valor)} para **{brl(c.valor)}**, ou corrigir o contas a pagar"})
    if (c and not b and not l.fora_do_periodo and not l.em_grupo and not l.debito_automatico
            and not l.justificativa and (banco_cobre_folha or not l.de_folha)):
        div.append({"tipo": "faltou_agendar", "diferenca": -c.valor, "situacao": "**Faltou agendar**",
                    "acao": f"agendar **{brl(c.valor)}** para **{l.pessoa}**" + (f" (vencimento {c.data})" if c.data else "")})
    if b and not c and not f and "efetuad" in (b.situacao or "").lower():
        l.ja_pago = True          # já saiu do banco; o Conta Azul costuma listar só o que está em aberto
    elif b and not c and not f:
        div.append({"tipo": "banco_sem_conta", "diferenca": b.valor, "situacao": "Agendado sem conta a pagar",
                    "acao": f"conferir o agendamento de **{l.pessoa}** ({brl(b.valor)}): não há conta a pagar correspondente"})
    dc, db = (_data(c.data), _data(b.data)) if c and b else (None, None)
    if datas_ok and dc and db and db > dc:
        div.append({"tipo": "data", "diferenca": 0, "situacao": f"Agendado para {b.data}, vence {c.data}",
                    "acao": f"rever a data do agendamento de **{l.pessoa}**: {b.data} é depois do vencimento {c.data}"})


def _soma(itens) -> int:
    return sum(i.valor for i in itens if i)


def _fechamento(linhas, banco, folha, banco_cobre_folha):
    rows = []
    com_banco = bool(banco) and banco_cobre_folha
    if folha:
        da_folha = [l for l in linhas if l.folha]
        rows.append((f"{len(da_folha)} pagamentos da folha (líquidos)", _soma(l.folha for l in da_folha),
                     _soma(l.conta for l in da_folha), _soma(l.banco for l in da_folha) if com_banco else None))
        ok = [l for l in da_folha if l.confere]
        if ok and len(ok) != len(da_folha):
            rows.append((f"{len(ok)} que conferem", _soma(l.folha for l in ok), _soma(l.conta for l in ok),
                         _soma(l.banco for l in ok) if com_banco else None))
    if banco:
        cobrados = [l.conta for l in linhas if l.conta and not l.fora_do_periodo and (banco_cobre_folha or not l.de_folha)]
        agendados = [b for l in linhas if banco_cobre_folha or not l.de_folha for b in [l.banco, *l.banco_grupo] if b]
        rotulo = "Contas a pagar do período" + ("" if banco_cobre_folha else " (sem a folha)")
        rows.append((f"{rotulo} × agendamentos ({len(cobrados)} × {len(agendados)})", None, _soma(cobrados), _soma(agendados)))
    return rows


def _explicacao(linhas, banco, banco_cobre_folha):
    """Cada parte da diferença contas × banco, e o que sobrar sem explicação."""
    if not banco:
        return []
    texto, explicado = [], 0
    for l in linhas:
        if l.de_folha and not banco_cobre_folha:
            continue
        c, b = l.conta, l.banco
        for d in l.divergencias:
            if d["tipo"] == "faltou_agendar":
                texto.append(f"{l.pessoa}: {brl(c.valor)} no contas a pagar e não agendado")
                explicado += c.valor
            elif d["tipo"] == "banco_sem_conta":
                texto.append(f"{l.pessoa}: {brl(b.valor)} agendado sem conta a pagar")
                explicado -= b.valor
            elif d["tipo"] == "valor_banco":
                texto.append(f"{l.pessoa}: agendamento {brl(abs(d['diferenca']))} {'acima' if d['diferenca'] > 0 else 'abaixo'} do contas a pagar")
                explicado += c.valor - b.valor
        if c and b and b.valor < c.valor and not any(d["tipo"] == "valor_banco" for d in l.divergencias):
            texto.append(f"{l.pessoa}: desconto de {brl(c.valor - b.valor)} no agendamento")
            explicado += c.valor - b.valor
        if l.ja_pago:
            texto.append(f"{l.pessoa}: {brl(b.valor)} já pago no banco, sem conta em aberto no contas a pagar")
            explicado -= b.valor
        if c and not b and l.debito_automatico and not l.fora_do_periodo:
            texto.append(f"{l.pessoa}: {brl(c.valor)} em débito automático, sem agendamento")
            explicado += c.valor
    cobrados = _soma(l.conta for l in linhas if l.conta and not l.fora_do_periodo and (banco_cobre_folha or not l.de_folha))
    agendados = sum(b.valor for l in linhas if banco_cobre_folha or not l.de_folha for b in [l.banco, *l.banco_grupo] if b)
    sobra = cobrados - agendados - explicado
    if sobra:
        texto.append(f"**{brl(abs(sobra))} sem explicação** pelas linhas acima: confira os valores associados")
    return texto


def _pontos(linhas, banco, folha, proprios, banco_cobre_folha, datas_ok):
    pontos = []
    if banco and not banco_cobre_folha:
        folha_linhas = [l for l in linhas if l.de_folha]
        total = _soma(l.folha or l.conta for l in folha_linhas)
        pontos.append(f"**O relatório do banco não traz nenhum pagamento da folha** ({len(folha_linhas)} lançamento(s), {brl(total)}). "
                      "Se a folha é paga por outro canal ou relatório, envie-o para completar a conferência.")
    for l in linhas:
        c, f, b = l.conta, l.folha, l.banco
        if c and eh_pensao(c):
            quem = f"agendada para **{nome_do_banco(b)}**" if b else "sem agendamento localizado"
            pontos.append(f"**Pensão — {brl(c.valor)}** ({pessoa_da_descricao(c) or 'funcionário não identificado'}): {quem}. "
                          "O extrato da folha não identifica a beneficiária; confirme se é a recebedora cadastrada.")
        elif folha and c and l.de_folha and not f:
            extra = " Confere com o banco." if b and b.valor == c.valor else ""
            pontos.append(f"**{l.pessoa} — {brl(c.valor)}** ({c.categoria or 'folha'}): não aparece no extrato da folha enviado; "
                          f"precisa de documento separado.{extra}")
        pontos.extend(l.avisos)
        if l.justificativa and c and not b:
            pontos.append(f"**{l.nome_conta} — {brl(c.valor)}**: sem agendamento, justificado pela sua observação.")
        if l.debito_automatico and c:
            pontos.append(f"**{l.pessoa} — {brl(c.valor)}**: débito automático, não precisa de agendamento.")
        if l.confianca == 50 and (f or b):
            pontos.append(f"**{l.pessoa}**: associação feita por nome parcial. Confirme se é a mesma pessoa.")
        referencia = f or b
        if c and referencia and l.de_folha and l.confianca >= 50 and not eh_pensao(c):
            nome_ref = referencia.nome if f else nome_do_banco(referencia)
            if len(tokens(l.nome_conta)) >= 2 and tokens(l.nome_conta) < tokens(nome_ref):
                cpf = " com CPF compatível" if f and b and cpf_compativel(f.documento, b.documento) else ""
                pontos.append(f"No contas a pagar aparece **{l.nome_conta}**; "
                              f"{'na folha' if f else 'no banco'} o nome completo é **{nome_ref}**{cpf}.")
        if c and b and b.situacao == "Efetuado" and "aberto" in (c.situacao or "").lower():
            pontos.append(f"**{l.pessoa} — {brl(c.valor)}**: já efetuado no banco e ainda em aberto no Conta Azul; dar baixa.")

    pagos = [l for l in linhas if l.ja_pago]
    if pagos:
        pontos.append(f"**Já pagos no banco, sem conta em aberto no contas a pagar** ({brl(_soma(l.banco for l in pagos))}): "
                      + "; ".join(f"{l.pessoa} ({brl(l.banco.valor)}{', ' + l.banco.data if l.banco.data else ''})"
                                  for l in pagos)
                      + ". Confirme se já foram baixados no Conta Azul.")
    fora = [l.conta for l in linhas if l.conta and l.fora_do_periodo]
    if fora:
        pontos.append(f"{len(fora)} conta(s) a pagar ({brl(_soma(fora))}) vencem fora do período do relatório do banco "
                      f"({' a '.join(banco.periodo)}) e não foram cobradas nos agendamentos.")
    if folha:
        zero = [i for i in folha.itens if i.valor == 0]
        if zero:
            pontos.append(f"{len(zero)} vínculo(s) da folha com líquido zero: não exigem pagamento.")

    duplicados = []
    for fonte, itens, nome in (("contas a pagar", [l.conta for l in linhas if l.conta], lambda i: nome_no_banco(i, proprios)),
                               ("banco", banco.itens if banco else [], nome_do_banco)):
        vistos = set()
        for i in itens:
            chave = (norm(nome(i)), i.valor)
            if chave[0] and chave in vistos:
                duplicados.append(f"{nome(i)} ({brl(i.valor)}, {fonte})")
            vistos.add(chave)
    if duplicados:
        pontos.append("Possível duplicidade: " + "; ".join(duplicados) + ".")
    elif banco:
        pontos.append("Não localizei pagamentos duplicados.")

    if banco and banco.itens:
        datas = sorted({i.data for i in banco.itens if _data(i.data)}, key=_data)
        situacoes = sorted({i.situacao for i in banco.itens if i.situacao})
        quando = (f"para **{datas[0]}**" if len(datas) == 1 else
                  f"entre **{datas[0]}** e **{datas[-1]}**" if datas else "sem data")
        pontos.append(f"Os {len(banco.itens)} agendamentos estão {quando}, situação: {', '.join(situacoes) or 'não informada'}.")
        if not datas_ok:
            pontos.append("As datas do Sicoob não foram comparadas com os vencimentos: confirme o que a coluna Data representa.")
    return pontos


def _acoes(linhas, contas, banco, folha):
    acoes = [d["acao"] for l in linhas for d in l.divergencias]
    if folha:
        ajuste = sum(d["diferenca"] for l in linhas for d in l.divergencias if d["tipo"] == "valor_folha")
        if ajuste:
            acoes.append(f"com isso, o total do contas a pagar passa de **{brl(contas.total)}** para **{brl(contas.total + ajuste)}**")
    if banco and any("pendente" in (i.situacao or "").lower() for i in banco.itens):
        acoes.append("depois dos ajustes, liberar as transações pendentes")
    return acoes


# ------------------------------------------------------------------ texto

def _v(x):
    return brl(x) if x is not None else "Não localizado"


def _tabela(cabecalho: list[str], linhas: list[list[str]], numericas: set[int]) -> list[str]:
    out = ["| " + " | ".join(cabecalho) + " |",
           "|" + "|".join("---:" if i in numericas else "---" for i in range(len(cabecalho))) + "|"]
    return out + ["| " + " | ".join(l) + " |" for l in linhas]


def _resumo_lista(x: dict) -> str:
    nome = nome_da_lista(x["rotulo"])
    base = f"**{nome[0].upper() + nome[1:]}** ({x['arquivo']}): {x['itens']} linha(s), {brl(x['total'])}. "
    if x["modo"] == "pessoa":
        return base + f"{x['conferem']} de {x['itens']} conferem com o contas a pagar, pessoa a pessoa."
    if not x["contas"]:
        return base + f"Nenhum lançamento de {x['rotulo']} no contas a pagar."
    situacao = ("Confere." if x["total"] == x["soma_contas"]
                else f"Diferença de **{brl(abs(x['total'] - x['soma_contas']))}**.")
    return base + (f"No contas a pagar, {brl(x['soma_contas'])} em {x['contas']} lançamento(s), "
                   f"comparado pelo total. {situacao}")


def renderizar(r: Relatorio) -> str:
    rotulos = list(dict.fromkeys(nome_da_lista(x["rotulo"]) for x in r.listas))
    fontes = (["o contas a pagar"] + (["a folha"] if r.tem_folha else []) + (["os agendamentos"] if r.tem_banco else [])
              + [f"a {x}" for x in rotulos])
    entre = ", ".join(fontes[:-1]) + " e " + fontes[-1]
    n_div, n_ok = len(r.divergentes), len(r.conferem)
    if not r.linhas:
        manchete = "**Não há lançamentos para conferir** com os arquivos enviados."
    elif n_div:
        resto = ("" if not n_ok else " O outro pagamento confere." if n_ok == 1
                 else f" Os outros {n_ok} pagamentos conferem.")
        manchete = (f"A conferência entre {entre} encontrou **{n_div} divergência{'s' if n_div > 1 else ''} "
                    f"confirmada{'s' if n_div > 1 else ''}**.{resto}")
    elif n_ok == 1:
        manchete = f"**Tudo confere.** O pagamento bate entre {entre}."
    else:
        manchete = f"**Tudo confere.** Os {n_ok} pagamentos batem entre {entre}."
    out = [manchete, ""]

    colunas = ((["Extrato da folha"] if r.tem_folha else []) + (["Planilha/lista"] if r.tem_lista else [])
               + ["Contas a pagar"] + (["Banco"] if r.tem_banco else []))
    if r.divergentes:
        linhas = []
        for l in r.divergentes:
            lista = l.lista.valor if l.lista else l.soma_lista
            conta = l.conta.valor if l.conta else l.soma_contas
            vals = (([l.folha.valor if l.folha else None] if r.tem_folha else []) + ([lista] if r.tem_lista else [])
                    + [conta] + ([l.banco.valor if l.banco else None] if r.tem_banco else []))
            linhas.append([l.pessoa or "(sem nome)"] + [_v(v) for v in vals] + ["; ".join(d["situacao"] for d in l.divergencias)])
        out += ["### Divergências confirmadas", ""]
        out += _tabela(["Favorecido"] + colunas + ["Situação"], linhas, set(range(1, len(colunas) + 1))) + [""]

    colunas = (["Extrato da folha"] if r.tem_folha else []) + ["Contas a pagar"] + (["Banco"] if r.tem_banco else [])
    linhas = []
    for nome, vf, vc, vb in r.fechamento:
        vals = ([vf] if r.tem_folha else []) + [vc] + ([vb] if r.tem_banco else [])
        presentes = [v for v in vals if v is not None]
        dif = max(presentes) - min(presentes) if len(presentes) > 1 else 0
        linhas.append([nome] + [brl(v) if v is not None else "—" for v in vals] + [f"**{brl(dif)}**" if dif else brl(0)])
    out += ["### Fechamento", ""]
    out += _tabela(["Comparação"] + colunas + ["Diferença"], linhas, set(range(1, len(colunas) + 2))) + [""]
    if r.explicacao:
        out += ["A diferença entre contas a pagar e banco vem de:", ""] + [f"* {t}" for t in r.explicacao] + [""]
    if r.listas:
        out += ["### Planilhas e listas", ""] + [f"* {_resumo_lista(x)}" for x in r.listas] + [""]

    if r.pontos:
        out += ["### Pontos para confirmar", ""] + [f"* {p}" for p in r.pontos] + [""]
    if r.acoes:
        frases = [a[0].upper() + a[1:] + "." for a in r.acoes]
        if len(frases) == 1:
            out += [f"**Ação:** {frases[0]}", ""]
        else:
            out += ["**Ação:**", ""] + [f"{n}. {f}" for n, f in enumerate(frases, 1)] + [""]
    if r.observacoes:
        out += ["### Suas observações", ""] + [f"* {o['texto']} → {o['efeito']}" for o in r.observacoes] + [""]
    return "\n".join(out).rstrip() + "\n"
