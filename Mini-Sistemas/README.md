# Mini-Sistemas

Processos de verdade: têm etapas, guardam estado, tratam erro e podem ser
chamados por outra coisa (o agente, o n8n, um agendador).

**O que entra aqui:** algo que roda repetidamente, precisa ser confiável, e
onde uma falha no meio não pode deixar sujeira.

**O que NÃO entra aqui:** script de uma tacada só — isso é
`../Ferramentas Auxiliares/`.

## Regras da casa

Valem para qualquer mini-sistema, em qualquer linguagem:

1. **Interface de máquina.** Além do uso humano, aceitar e devolver JSON. É
   assim que o agente e o n8n conversam com ele, sem depender de ler texto.
2. **Configuração fora do código.** Caminho de pasta, credencial e afins vêm
   de `.env`. Nada de caminho de máquina escrito no meio do código.
3. **Simulação primeiro.** Toda operação que escreve tem como mostrar o que
   faria antes de fazer.
4. **Nunca destruir em silêncio.** Não sobrescrever, não apagar. Se já existe,
   versionar ou avisar.
5. **Diário.** Registro append-only do que aconteceu, para auditar depois.
6. **Teste.** A parte que decide precisa rodar sem tocar em disco de produção.

## Sistemas

| Sistema | O que faz |
|---|---|
| [`arquivador_docs`](arquivador_docs/) | Cataloga, renomeia e arquiva documentos na pasta do OneDrive sincronizado |
