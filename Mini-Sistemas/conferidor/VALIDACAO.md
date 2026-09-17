# Validação

## 17/09/2026 — primeira rodada pelo chat (v0.5)

Teste do operador numa quinzena (11 a 20/09) de uma empresa: 6 divergências,
das quais 4 eram falsas. Causas e correções:

- FGTS com fornecedor "Receita Federal" casado pelo nome com o DARF do INSS;
  o PIX à Caixa e o INSS sobravam logo abaixo. Agora a categoria indica o
  favorecido, o valor igual pesa e o par é trocado.
- INSS contado como folha ("INSS sobre Salários") e folha cobrada fora da
  janela do dia 28 ao dia 08.
- Pagamentos "Efetuados" no banco sem conta em aberto contados como divergência.

Resultado na mesma amostra: 2 divergências (as duas contas não agendadas) e a
diferença de totais 100% explicada; conferido também pela interface do chat.

- Python: **76 testes aprovados** (leitura de planilha/texto, janela da folha,
  categoria, troca de pares, pagos no banco, VT/VA pessoa a pessoa e pelo
  total, mensagem formatada, empresa pelo nome do arquivo).
- Agente: 286 testes aprovados, typecheck e lint limpos.

## 16/09/2026 — ligação com o agente (v0.4)

- Python: **50 testes aprovados** (8 novos da entrada JSON: lote vazio, limite
  de arquivos, base64 inválido, arquivo que não é PDF, relação inválida,
  entrada quebrada e as três amostras pelo processo).
- Agente: 12 testes novos da ferramenta (contrato, validação, anexo de outro
  usuário, bloqueado, planilha, ordem e conteúdo enviados); suíte com 274
  aprovados e typecheck limpo.
- Ponte Node → Python com as amostras: 1, 1 e 2 divergências, como esperado,
  em 1 a 4 s por empresa.

## 16/09/2026 — descrição, observações e mensagem (v0.3)

Comando: `python -m pytest -q -p no:cacheprovider`. Resultado: **42 testes aprovados**.

- Boleto do Sicoob sem favorecido casa pela descrição; descrição parecida com
  valor diferente não casa.
- Data do Sicoob tratada como data do agendamento: depois do vencimento é
  divergência, antes não. Associação por valor aceita agendamento até 30 dias antes.
- Observações: folha em apuração, favorecido justificado, observação desmentida
  pelo banco e observação sem relação — cada uma com o efeito exibido.
- Mensagem: texto idêntico ao modelo com observações; sem observações; banco
  efetuado; saudação pelo horário; pendências antes do envio.
- Amostras reais: mesmas divergências da v0.2. Na Empresa A, três pares que eram
  "associados só pelo valor" passaram a casar pela descrição.

## 16/09/2026 — conferência em três vias (v0.2)

Comando: `python -m pytest -q -p no:cacheprovider`.
Resultado: **32 testes aprovados**.

- 15 casos sintéticos da conferência em três vias:
  - folha, contas e banco batendo;
  - salário a menor no contas;
  - faltou agendar e agendado sem conta;
  - desconto de 5% que não é divergência, e diferença que é;
  - pensão com beneficiária diferente do funcionário;
  - sócio que recebe pela empresa, com a relação aprendida;
  - pagamento conjunto;
  - valores iguais sem nome, que não se casam;
  - folha fora do relatório do banco;
  - débito automático;
  - CPF incompatível;
  - conta fora do período;
  - lote sem banco nem folha.
- Amostras reais das três empresas: as divergências esperadas batem exatamente,
  e a diferença contas × banco fica 100% explicada.
- Interface: título, execução por empresa, aba de conferência e invalidação
  após mudança de entrada.

Resultado nas amostras de 04 a 13/09/2026:

| Empresa | Resultado |
|---|---|
| Empresa A (Sicoob) | 1 divergência: conta não agendada, igual à diferença do fechamento |
| Empresa B (Itaú) | 1 divergência: salário a menor no contas; banco sem pagamentos da folha |
| Empresa C (Itaú) | 2 divergências: contas não agendadas; banco sem pagamentos da folha |

O piloto não consolidava: listava, por par de documentos, cada associação e cada
item sem par, o que deixava muitos itens para revisar à mão.

As associações por valor e os pagamentos conjuntos são **pontos para
confirmar**, não certezas. A primeira validação humana deve revisar esses
pontos nas três amostras.

## 16/09/2026 — piloto (v0.1)

23 testes aprovados: leitura dos nove PDFs, totais de controle e cruzamento par
a par. Execução de uma amostra em 1,07 s no navegador, zero chamadas de IA.
