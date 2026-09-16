# Validação

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
