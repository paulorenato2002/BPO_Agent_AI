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
from datetime import date

from core import Documento, Item, brl, norm

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

CONFIANCA_POR_VALOR = 40


# ------------------------------------------------------------------ identificação

def eh_folha(item: Item) -> bool:
    texto = norm(item.categoria + " " + item.descricao)
    return any(r in texto for r in ROTULOS_FOLHA)


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
    return max(_pontuar_nome(a, b), _pontuar_descricao(a, b))


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
                pares.append((s, a.item.valor == b.item.valor, a, b))
    pares.sort(key=lambda p: (-p[0], not p[1]))
    usados_a, usados_b, res = set(), set(), {}
    for s, _, a, b in pares:
        if a.chave in usados_a or b.chave in usados_b:
            continue
        res[a.chave] = (b, s)
        usados_a.add(a.chave)
        usados_b.add(b.chave)

    if por_valor:
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

    @property
    def divergentes(self) -> list[Linha]:
        return [l for l in self.linhas if l.divergencias]

    def markdown(self) -> str:
        return renderizar(self)


def conferir_tres(contas: Documento, banco: Documento | None = None, folha: Documento | None = None,
                  relacoes: dict[str, str] | None = None, aceitar_data_sicoob: bool = True,
                  observacoes: str = "") -> Relatorio:
    """Sem banco: só as contas de folha entram (as demais são desconsideradas)."""
    relacoes = relacoes or {}
    if not (banco or folha):
        raise ValueError("Envie o extrato da folha, os agendamentos do banco ou os dois.")

    proprios = fornecedores_proprios(contas.itens)
    contas_itens = [i for i in contas.itens if banco or eh_folha(i)]
    periodo = [_data(x) for x in banco.periodo] if banco and len(banco.periodo) == 2 else None

    m_cf = {}
    if folha:
        # A pensão não é linha própria no extrato: fica fora deste cruzamento.
        m_cf = casar([Ref(i.id, i, pessoa_da_descricao(i) or i.nome) for i in contas_itens if eh_folha(i) and not eh_pensao(i)],
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
        linha = Linha(pessoa, c, f[0].item if f else None, b[0].item if b else None, de_folha=eh_folha(c),
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

    lidas, folha_em_apuracao = _ler_observacoes(observacoes, linhas)
    cobre = banco_cobre_folha and not folha_em_apuracao
    for l in linhas:
        _classificar(l, folha is not None, banco is not None, cobre, datas_ok)
    _efeito_observacoes(lidas, linhas, folha_em_apuracao)

    return Relatorio(folha is not None, banco is not None, banco_cobre_folha, linhas,
                     _fechamento(linhas, banco, folha, cobre),
                     _explicacao(linhas, banco, cobre),
                     _pontos(linhas, banco, folha, proprios, banco_cobre_folha or folha_em_apuracao, datas_ok),
                     _acoes(linhas, contas, banco, folha), lidas, folha_em_apuracao, contas.periodo)


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
    if b and not c and not f:
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
        pontos.append(f"**O relatório do banco não traz nenhum pagamento da folha** ({len(folha_linhas)} lançamentos, {brl(total)}). "
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


def renderizar(r: Relatorio) -> str:
    fontes = ["o contas a pagar"] + (["a folha"] if r.tem_folha else []) + (["os agendamentos"] if r.tem_banco else [])
    entre = ", ".join(fontes[:-1]) + " e " + fontes[-1]
    n_div, n_ok = len(r.divergentes), len(r.linhas) - len(r.divergentes)
    if n_div:
        manchete = (f"A conferência entre {entre} encontrou **{n_div} divergência{'s' if n_div > 1 else ''} "
                    f"confirmada{'s' if n_div > 1 else ''}**. Os outros {n_ok} pagamentos conferem.")
    else:
        manchete = f"**Tudo confere.** Os {n_ok} pagamentos batem entre {entre}."
    out = [manchete, ""]

    colunas = (["Extrato da folha"] if r.tem_folha else []) + ["Contas a pagar"] + (["Banco"] if r.tem_banco else [])
    if r.divergentes:
        linhas = []
        for l in r.divergentes:
            vals = ([l.folha.valor if l.folha else None] if r.tem_folha else []) + [l.conta.valor if l.conta else None] \
                + ([l.banco.valor if l.banco else None] if r.tem_banco else [])
            linhas.append([l.pessoa or "(sem nome)"] + [_v(v) for v in vals] + ["; ".join(d["situacao"] for d in l.divergencias)])
        out += ["### Divergências confirmadas", ""]
        out += _tabela(["Favorecido"] + colunas + ["Situação"], linhas, set(range(1, len(colunas) + 1))) + [""]

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
