"use client";

import { useState } from "react";
import { IconeAlerta, IconeCheck, IconeCopiar, IconeDrive } from "../../componentes/icones";
import type { TokenParaExibir } from "@/lib/integracoes/refresh-token-temporario";

type Props = {
  erro: string | null;
  configFaltando: string[] | null;
  jaTemRefreshToken: boolean;
  token: TokenParaExibir | null;
  exibicaoPermitida: boolean;
  ehLocal: boolean;
};

export function PainelConexao({
  erro,
  configFaltando,
  jaTemRefreshToken,
  token,
  exibicaoPermitida,
  ehLocal,
}: Props) {
  return (
    <div className="mt-6 space-y-4">
      {erro && (
        <Caixa tom="erro" titulo="Não foi possível conectar">
          {erro}
        </Caixa>
      )}

      {configFaltando && (
        <Caixa tom="atencao" titulo="Configuração incompleta">
          Defina no <code className="rounded bg-black/5 px-1">.env.local</code>:
          <ul className="mt-2 list-disc space-y-0.5 pl-5 font-mono text-xs">
            {configFaltando.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
        </Caixa>
      )}

      {token?.ok && <TokenRevelado refreshToken={token.refreshToken} email={token.email} />}

      {token && !token.ok && (
        <Caixa tom="atencao" titulo="Token não disponível">
          {token.motivo === "desabilitado" &&
            "A exibição do token é desabilitada fora do ambiente local."}
          {token.motivo === "expirado" && "O prazo de 5 minutos para copiar expirou. Conecte de novo."}
          {token.motivo === "nao_encontrado" &&
            "Este link já foi usado ou o servidor reiniciou. Conecte de novo."}
          {token.motivo === "outro_usuario" && "Este token pertence a outra autorização."}
        </Caixa>
      )}

      {!token?.ok && (
        <div className="rounded-2xl border border-borda bg-fundo-cartao p-6">
          <div className="flex items-start gap-3">
            <IconeDrive className="h-8 w-8" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-texto">
                {jaTemRefreshToken ? "Reautorizar o Google Drive" : "Autorizar o Google Drive"}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-texto-suave">
                {jaTemRefreshToken
                  ? "Já existe um refresh token configurado. Reautorize apenas se ele tiver sido revogado."
                  : "Você será levado ao Google para autorizar. Depois, copie o refresh token e salve no .env.local."}
              </p>
            </div>
          </div>

          <a
            href="/api/integracoes/google-drive/conectar"
            className={`mt-5 flex w-full items-center justify-center rounded-xl px-4 py-2.5 text-[15px] font-medium text-white transition-colors ${
              configFaltando
                ? "pointer-events-none bg-azul/40"
                : "bg-azul hover:bg-azul-hover"
            }`}
            aria-disabled={Boolean(configFaltando)}
          >
            {jaTemRefreshToken ? "Reautorizar" : "Conectar com o Google"}
          </a>

          {!ehLocal && (
            <p className="mt-3 text-center text-xs text-ambar">
              Fora do ambiente local o token não é exibido — configure-o direto no
              ambiente do servidor.
            </p>
          )}
          {ehLocal && !exibicaoPermitida && (
            <p className="mt-3 text-center text-xs text-ambar">
              Exibição do token desabilitada neste ambiente.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Mostra o refresh token UMA ÚNICA VEZ.
 *
 * Fica oculto por padrão: quem estiver ao lado, ou uma gravação de tela, não
 * captura o valor sem uma ação deliberada.
 */
function TokenRevelado({
  refreshToken,
  email,
}: {
  refreshToken: string;
  email: string | null;
}) {
  const [visivel, setVisivel] = useState(false);
  const [copiado, setCopiado] = useState(false);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(refreshToken);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      setVisivel(true); // sem clipboard, ao menos deixa copiar à mão
    }
  }

  return (
    <div className="rounded-2xl border border-verde/30 bg-verde-suave p-6">
      <div className="flex items-start gap-2.5">
        <IconeCheck className="mt-0.5 h-5 w-5 text-verde" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-verde">Autorização concluída</p>
          {email && (
            <p className="mt-0.5 text-sm text-texto-suave">
              Conta autorizada: <strong>{email}</strong>
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-ambar/40 bg-ambar-suave px-3.5 py-2.5 text-sm text-ambar">
        <strong>Salve agora.</strong> Este valor aparece uma única vez — ao
        recarregar a página ele some para sempre.
      </div>

      <p className="mt-4 mb-1.5 text-sm font-medium text-texto">
        Cole esta linha no seu <code className="rounded bg-black/5 px-1">.env.local</code>:
      </p>

      <div className="overflow-hidden rounded-xl border border-borda bg-fundo-cartao">
        <pre className="overflow-x-auto px-3.5 py-3 font-mono text-xs text-texto">
          {visivel
            ? `GOOGLE_DRIVE_REFRESH_TOKEN=${refreshToken}`
            : `GOOGLE_DRIVE_REFRESH_TOKEN=${"•".repeat(42)}`}
        </pre>
        <div className="flex gap-2 border-t border-borda px-3 py-2">
          <button
            onClick={copiar}
            className="flex items-center gap-1.5 rounded-lg bg-azul px-3 py-1.5 text-xs font-medium text-white hover:bg-azul-hover"
          >
            {copiado ? <IconeCheck className="h-3.5 w-3.5" /> : <IconeCopiar className="h-3.5 w-3.5" />}
            {copiado ? "Copiado" : "Copiar"}
          </button>
          <button
            onClick={() => setVisivel(!visivel)}
            className="rounded-lg border border-borda px-3 py-1.5 text-xs font-medium text-texto-suave hover:bg-fundo-sutil"
          >
            {visivel ? "Ocultar" : "Mostrar"}
          </button>
        </div>
      </div>

      <ol className="mt-5 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-texto-suave">
        <li>Cole a linha no <code className="rounded bg-black/5 px-1">.env.local</code>.</li>
        <li>Reinicie o servidor (o .env só é lido na inicialização).</li>
        <li>
          Rode <code className="rounded bg-black/5 px-1">npm run drive:bootstrap</code> para
          criar a pasta <strong>BPO_FINANCEIRO</strong>.
        </li>
        <li>
          Rode <code className="rounded bg-black/5 px-1">npm run drive:verificar</code> para o
          teste real de ponta a ponta.
        </li>
      </ol>
    </div>
  );
}

function Caixa({
  tom,
  titulo,
  children,
}: {
  tom: "erro" | "atencao";
  titulo: string;
  children: React.ReactNode;
}) {
  const estilo =
    tom === "erro"
      ? "border-vermelho/25 bg-vermelho-suave text-vermelho"
      : "border-ambar/30 bg-ambar-suave text-ambar";

  return (
    <div role="alert" className={`rounded-2xl border px-4 py-3.5 ${estilo}`}>
      <p className="flex items-center gap-2 font-medium">
        <IconeAlerta className="h-4 w-4" />
        {titulo}
      </p>
      <div className="mt-1.5 text-sm leading-relaxed text-texto-suave">{children}</div>
    </div>
  );
}
