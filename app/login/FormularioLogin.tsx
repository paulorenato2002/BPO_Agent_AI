"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import Image from "next/image";
import { entrar, recuperarSenha, type EstadoLogin } from "./acoes";
import { IconeAlerta, IconeCheck } from "../componentes/icones";

type Props = { proximo: string; motivo?: string };

export function FormularioLogin({ proximo, motivo }: Props) {
  const [modo, setModo] = useState<"entrar" | "recuperar">("entrar");
  const [estadoEntrar, acaoEntrar] = useActionState<EstadoLogin, FormData>(entrar, {});
  const [estadoRecuperar, acaoRecuperar] = useActionState<EstadoLogin, FormData>(
    recuperarSenha,
    {}
  );

  const estado = modo === "entrar" ? estadoEntrar : estadoRecuperar;

  return (
    <div className="w-full max-w-[400px]">
      <div className="mb-8 flex flex-col items-center text-center">
        <Image
          src="/logo-effective.png"
          alt="Effective Assessoria"
          width={96}
          height={96}
          priority
          className="mb-4 h-24 w-24 object-contain"
        />
        <h1 className="text-xl font-semibold tracking-tight text-texto">Effective AI</h1>
        <p className="mt-1 text-sm text-texto-suave">Agente Operacional</p>
      </div>

      <div className="rounded-2xl border border-borda bg-fundo-cartao p-6 shadow-sm">
        {/* Mensagem vinda do redirecionamento (ex.: sessão expirada). */}
        {motivo && !estado.erro && !estado.aviso && (
          <Aviso tipo="atencao">{motivo}</Aviso>
        )}
        {estado.erro && <Aviso tipo="erro">{estado.erro}</Aviso>}
        {estado.aviso && <Aviso tipo="sucesso">{estado.aviso}</Aviso>}

        {modo === "entrar" ? (
          <form action={acaoEntrar} className="space-y-4">
            <input type="hidden" name="proximo" value={proximo} />
            <CampoEmail />
            <CampoSenha />
            <BotaoEnviar rotulo="Entrar" carregando="Entrando…" />
            <button
              type="button"
              onClick={() => setModo("recuperar")}
              className="w-full text-center text-sm text-azul hover:underline"
            >
              Esqueci minha senha
            </button>
          </form>
        ) : (
          <form action={acaoRecuperar} className="space-y-4">
            <p className="text-sm leading-relaxed text-texto-suave">
              Informe seu e-mail e enviaremos as instruções para redefinir a senha.
            </p>
            <CampoEmail />
            <BotaoEnviar rotulo="Enviar instruções" carregando="Enviando…" />
            <button
              type="button"
              onClick={() => setModo("entrar")}
              className="w-full text-center text-sm text-azul hover:underline"
            >
              Voltar para o login
            </button>
          </form>
        )}
      </div>

      <p className="mt-6 text-center text-xs text-texto-fraco">
        O acesso é criado por um administrador. Não há cadastro público.
      </p>
    </div>
  );
}

function CampoEmail() {
  return (
    <div>
      <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-texto">
        E-mail
      </label>
      <input
        id="email"
        name="email"
        type="email"
        required
        autoComplete="email"
        autoFocus
        placeholder="voce@gestaocontabil.com"
        className="w-full rounded-xl border border-borda bg-fundo-app px-3.5 py-2.5 text-[15px] text-texto placeholder:text-texto-fraco focus:border-azul focus:outline-none"
      />
    </div>
  );
}

function CampoSenha() {
  const [visivel, setVisivel] = useState(false);

  return (
    <div>
      <label htmlFor="senha" className="mb-1.5 block text-sm font-medium text-texto">
        Senha
      </label>
      <div className="relative">
        <input
          id="senha"
          name="senha"
          type={visivel ? "text" : "password"}
          required
          autoComplete="current-password"
          className="w-full rounded-xl border border-borda bg-fundo-app px-3.5 py-2.5 pr-20 text-[15px] text-texto focus:border-azul focus:outline-none"
        />
        <button
          type="button"
          onClick={() => setVisivel(!visivel)}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-xs font-medium text-texto-suave hover:bg-fundo-sutil hover:text-texto"
          aria-label={visivel ? "Ocultar senha" : "Mostrar senha"}
        >
          {visivel ? "Ocultar" : "Mostrar"}
        </button>
      </div>
    </div>
  );
}

function BotaoEnviar({ rotulo, carregando }: { rotulo: string; carregando: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex w-full items-center justify-center gap-2 rounded-xl bg-azul px-4 py-2.5 text-[15px] font-medium text-white transition-colors hover:bg-azul-hover disabled:opacity-60"
    >
      {pending && (
        <span
          className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
          aria-hidden
        />
      )}
      {pending ? carregando : rotulo}
    </button>
  );
}

function Aviso({
  tipo,
  children,
}: {
  tipo: "erro" | "sucesso" | "atencao";
  children: React.ReactNode;
}) {
  const estilos = {
    erro: "border-vermelho/25 bg-vermelho-suave text-vermelho",
    sucesso: "border-verde/25 bg-verde-suave text-verde",
    atencao: "border-ambar/25 bg-ambar-suave text-ambar",
  }[tipo];

  return (
    <div
      role={tipo === "erro" ? "alert" : "status"}
      className={`mb-4 flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-sm ${estilos}`}
    >
      {tipo === "sucesso" ? (
        <IconeCheck className="mt-0.5 h-4 w-4 shrink-0" />
      ) : (
        <IconeAlerta className="mt-0.5 h-4 w-4 shrink-0" />
      )}
      <span>{children}</span>
    </div>
  );
}
