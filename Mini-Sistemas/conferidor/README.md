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
- **Extrato mensal da folha**;
- **Planilhas de VT/VA** (XLSX ou CSV), **arquivos .txt** e **dados colados**
  na mensagem ("Fulano — R$ 150,00", uma pessoa por linha; uma linha com "VT"
  ou "Vale alimentação" abre a seção).

Com contas a pagar + folha, só os lançamentos de folha entram; as demais contas
são desconsideradas. Com o banco, entram todas as contas do período do relatório.

Na tela ainda vão a **empresa** (nome curto, como L2H; vazio usa o prefixo do
nome do arquivo), o **cliente** (como marcá-lo no WhatsApp) e as
**observações**, uma por linha.

## Como confere

**Janela da folha:** salário, pró-labore, estágio, férias e rescisão são pagos
do dia 28 ao dia 08. Fora disso o lançamento é tratado como pagamento comum, e
o extrato da folha só entra quando o período do contas a pagar inclui algum
desses dias. INSS, FGTS, IRRF e contribuição sindical são guias, não folha.

Cada pagamento vira uma linha com o que cada fonte diz dele.

1. **Contas × folha:** pela pessoa da descrição ("SALÁRIO - NOME"). Pensão fica
   fora, porque o extrato não a traz como linha própria.
2. **Contas × banco:** pelo favorecido. Em folha, distribuição de lucros e
   devolução de aporte, o favorecido é a pessoa da descrição, não a empresa
   cadastrada como fornecedor. O CPF da folha acompanha o lançamento.
3. **Folha × banco:** o que sobrou, com o CPF completo da folha contra o CPF
   mascarado do banco.

Boleto do Sicoob não tem favorecido, só observação: ela é comparada com a
**descrição** do contas a pagar (mesmo valor e as mesmas palavras). O nome casa por palavras, ignorando rótulos (salário, bolsa, LTDA...) e aceitando
abreviação do banco ("MERCADO CENT"). Nome de uma palavra só ("TRANSPORTADORA") só
vale com o mesmo valor. A categoria também indica o
favorecido quando o valor é o mesmo: FGTS é pago à Caixa; INSS, DARF e
impostos federais, à Receita; IPTU e ISS, à prefeitura. O valor igual pesa no
casamento: um nome parecido com outro valor não tira o par exato de ninguém, e
um par com valores diferentes cujos "complementos" sobraram dos dois lados é
trocado. O que sobra ainda é associado quando o valor é único
dos dois lados; a relação aprendida vale para os outros pagamentos entre os
mesmos nomes (sócio × empresa do sócio). Lançamento com vários beneficiários
("ANA / BRUNO") fecha com os agendamentos das pessoas se a soma bater.

**Divergência confirmada:** valor diferente entre folha e contas a pagar; na
folha sem conta a pagar; faltou agendar; agendado sem conta a pagar; valor
agendado diferente; agendado depois do vencimento.

**Pago no banco sem conta em aberto:** agendamento já "Efetuado" sem conta no
contas a pagar vira ponto para confirmar a baixa no Conta Azul, que costuma
listar só o que está em aberto.

**Planilhas e listas:** a planilha de VT/VA é conferida pessoa a pessoa quando
o contas a pagar tem um lançamento por pessoa, e pelo total quando o benefício
é pago numa conta só (a operadora: Alelo, VR, Ticket...). Lista sem rótulo é
comparada com todas as contas. Diferenças viram divergência; a seção
**Planilhas e listas** resume cada uma. A leitura acha a coluna de nome, a de
valor (prefere "total"/"a pagar" a "valor diário") e a linha de total; linha
com valor ilegível ou total que não fecha bloqueia a conferência.

**Ponto para confirmar (não é divergência):** desconto em percentual redondo,
associação por valor, pagamento conjunto com divisão diferente, pensão e sua
beneficiária, lançamento de folha sem base no extrato, nome incompleto no Conta
Azul, efetuado no banco e em aberto no Conta Azul, débito automático, contas
fora do período do banco, duplicidade, datas e situação dos agendamentos.

Se o relatório do banco não traz nenhum pagamento da folha, a folha não é
cobrada nos agendamentos: vira um ponto pedindo o relatório que falta.

O fechamento mostra os totais e explica a diferença entre contas a pagar e
banco linha a linha. Sobra sem explicação aparece destacada.

## Observações do operador

Cada linha tem um efeito visível no resultado, na seção **Suas observações**:

- **folha em apuração** ("a folha encontra-se em apuração", "salários em
  fechamento"): os lançamentos de folha sem agendamento não viram "faltou agendar";
- **cita um favorecido** que não foi agendado ("Fornecedor X — boleto ainda não
  recebido"): justifica a ausência;
- **cita um favorecido que está agendado** e diz que não está: alerta de contradição;
- **não cita nada que o sistema reconheça**: vai só para a mensagem, e o
  resultado diz isso.

O reconhecimento é por regra fixa e palavra do nome, não interpretação livre.
Frase que não se encaixa aparece como "vai só na mensagem" — nunca é ignorada
em silêncio.

## Mensagem ao cliente

`mensagem.py` monta o texto de WhatsApp a partir de `modelos/mensagem_whatsapp.txt`,
com a formatação do WhatsApp (*negrito*, "- " para itens, linha em branco entre
blocos): saudação pelo horário e cliente ("@" sozinho fica para marcar no
próprio WhatsApp), título com a empresa e o período, uma frase sobre os
agendamentos e as observações na ordem escrita. Divergências não entram no
texto; aparecem num aviso acima dele para serem resolvidas antes do envio.

## Limites

- A coluna Data do Sicoob é a data do agendamento: agendamento depois do
  vencimento é divergência; antes, não.
- Contas a pagar e agendamentos em Excel, imagens/OCR e outros layouts ficam
  para depois. Planilha .xls antiga precisa ser salva como .xlsx.
- A leitura de VT/VA foi feita sem planilha real de exemplo: validar com um
  arquivo do dia a dia.
- A aba **Auditoria detalhada** mantém o cruzamento par a par do piloto, com o
  motivo de cada associação.

## Amostras

`docs_amostra/` fica fora do git: PDFs reais e `esperado.json`, com os valores
que os testes cobram delas. Sem essa pasta, os testes com amostras são pulados.

## Integração com o agente

O chat chama a ferramenta `conferir_agendamentos`
(`lib/ferramentas/conferimento.ts`). Ela confere que os anexos são do usuário,
não bloqueados e num formato lido, e chama `python cli.py json --stdin` nesta pasta:

- entrada: `{"arquivos": [{"nome", "base64"}], "empresa", "cliente", "observacoes",
  "relacoes", "dados_texto"}` — PDF, XLSX, CSV ou TXT, até 8 arquivos;
- saída: `{ok, erros, documentos, divergencias, empresa, avisos, relatorio_markdown,
  pendencias_antes_de_enviar, mensagem_whatsapp}` — JSON até em erro.

Tela e agente usam o mesmo `lote.conferir_lote`, com as mesmas regras de
bloqueio. Nada é gravado; a mensagem não é enviada ao cliente.

Só roda onde há Python com as dependências (hoje, o ambiente local). O
executável vem de `CONFERIDOR_PYTHON`, depois `ARQUIVADOR_PYTHON`, depois
`python`. O modelo da mensagem ainda é o arquivo em `modelos/`.
