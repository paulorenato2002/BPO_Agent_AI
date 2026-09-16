# Conferimento de agendamentos

Confere se o **contas a pagar** bate com os **agendamentos do banco** e com o
**extrato mensal da folha**. Responde no formato que o operador usa: quantas
divergências, qual o fechamento dos totais, o que precisa ser confirmado e o
que fazer.

Processamento local e determinístico: sem IA, sem chamadas externas, sem
conexão com o banco do agente. Os PDFs originais não são alterados.

## Executar

Nesta pasta, com Python 3.11 ou superior:

```powershell
python -m pip install -r requirements.txt
python -m streamlit run app.py
```

Abrir http://localhost:8501 (ou `./iniciar.ps1`). Testes: `python -m pytest -q`.

## Entradas

Um lote por empresa:

- **Contas a pagar** do Conta Azul (PDF) — obrigatório;
- **Agendamentos** do Itaú (dois layouts) ou do Sicoob (transações pendentes);
- **Extrato mensal da folha**.

Com contas a pagar + folha, só os lançamentos de folha entram; as demais contas
são desconsideradas. Com o banco, entram todas as contas do período do relatório.

## Como confere

Cada pagamento vira uma linha com o que cada fonte diz dele.

1. **Contas × folha:** pela pessoa da descrição ("SALÁRIO - NOME"). Pensão fica
   fora, porque o extrato não a traz como linha própria.
2. **Contas × banco:** pelo favorecido. Em folha, distribuição de lucros e
   devolução de aporte, o favorecido é a pessoa da descrição, não a empresa
   cadastrada como fornecedor. O CPF da folha acompanha o lançamento.
3. **Folha × banco:** o que sobrou, com o CPF completo da folha contra o CPF
   mascarado do banco.

O nome casa por palavras, ignorando rótulos (salário, bolsa, LTDA...) e aceitando
abreviação do banco ("MERCADO CENT"). Nome de uma palavra só ("TRANSPORTADORA") só
vale com o mesmo valor. O que sobra ainda é associado quando o valor é único
dos dois lados; a relação aprendida vale para os outros pagamentos entre os
mesmos nomes (sócio × empresa do sócio). Lançamento com vários beneficiários
("ANA / BRUNO") fecha com os agendamentos das pessoas se a soma bater.

**Divergência confirmada:** valor diferente entre folha e contas a pagar; na
folha sem conta a pagar; faltou agendar; agendado sem conta a pagar; valor
agendado diferente; agendado depois do vencimento.

**Ponto para confirmar (não é divergência):** desconto em percentual redondo,
associação por valor, pagamento conjunto com divisão diferente, pensão e sua
beneficiária, lançamento de folha sem base no extrato, nome incompleto no Conta
Azul, efetuado no banco e em aberto no Conta Azul, débito automático, contas
fora do período do banco, duplicidade, datas e situação dos agendamentos.

Se o relatório do banco não traz nenhum pagamento da folha, a folha não é
cobrada nos agendamentos: vira um ponto pedindo o relatório que falta.

O fechamento mostra os totais e explica a diferença entre contas a pagar e
banco linha a linha. Sobra sem explicação aparece destacada.

## Limites

- Datas do Sicoob só são comparadas se o operador marcar que a coluna é a data
  do pagamento.
- Excel, imagens/OCR e outros layouts ficam para depois.
- A aba **Auditoria detalhada** mantém o cruzamento par a par do piloto, com o
  motivo de cada associação.

## Amostras

`docs_amostra/` fica fora do git: PDFs reais e `esperado.json`, com os valores
que os testes cobram delas. Sem essa pasta, os testes com amostras são pulados.

## Integração com o agente

`core.ler_pdf(nome, bytes)` → `Documento`.
`conferencia.conferir_tres(contas, banco, folha, relacoes, aceitar_data_sicoob, observacoes)`
→ `Relatorio`, com `.markdown()` pronto para a conversa. Antes de expor ao
agente: escopo por empresa, autenticação, limites de execução e onde o
resultado fica guardado.
