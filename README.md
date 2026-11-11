# FNX DEV — site de vendas

Site + API num único Worker da Cloudflare (igual ao esquema da Molina Growth).

```
fnx-dev/
├─ public/                 ← site (o que o visitante vê)
│  ├─ index.html           ← página principal (planos, projetos, checkout, personalizado, contato)
│  ├─ politicas.html       ← termos, privacidade, reembolso 7 dias, países, contrato (em branco) — PT
│  ├─ policies.html        ← as mesmas políticas em inglês — EN
│  ├─ _headers             ← evita o navegador mostrar versão antiga do site
│  ├─ sucesso.html         ← depois de pagar
│  ├─ cancelado.html       ← se desistir no pagamento
│  └─ assets/
│     ├─ projetos/         ← prints dos projetos
│     ├─ js/               ← libphonenumber (formata o WhatsApp de cada país) + licença
│     └─ fonts/            ← fonte Montserrat hospedada no próprio site (sem Google Fonts)
├─ src/worker.js           ← API: Stripe, e-mails (Resend), bloqueio de países, contrato
└─ wrangler.jsonc          ← configuração do Worker
```

---

## Passo a passo para colocar no ar

### 1. Criar o repositório no GitHub
1. Entre em github.com → **New repository** → nome `FNX_DEV` → **Create repository**.
2. No VS Code, abra a pasta `fnx-dev` e no terminal rode:
```bash
git init
git add .
git commit -m "Site FNX DEV: planos, checkout Stripe, e-mails e politicas"
git branch -M main
git remote add origin https://github.com/Fnx1982/FNX_DEV.git
git push -u origin main
```

### 2. Criar o Worker ligado ao GitHub (na conta **fnxholding**)
> O Worker precisa ficar na **mesma conta Cloudflare do domínio** `fnxholding.com`. Um Worker de outra conta
> não consegue usar esse subdomínio (a Cloudflare bloqueia com o erro 1014).
1. Entre na conta **fnxholding** → **Workers & Pages** → **Create** → **Import a repository** → escolha `FNX_DEV`.
2. Nome do projeto: `fnx-dev`. Deixe o comando de deploy padrão (`npx wrangler deploy`). **Deploy**.
3. Depois em **Settings → Domains & Routes → Add → Custom domain**: `dev.fnxholding.com`
   (ou outro subdomínio; se mudar, altere `SITE_URL` no `wrangler.jsonc`).

### 3. Resend (e-mails)
> O plano grátis do Resend permite **1 domínio por conta**. A conta da Molina já usa o `molinagrowthagency.com`,
> então crie uma conta nova com um e-mail da FNX — ela serve também para a recuperação de senha do FNX TECH.
1. resend.com → **Domains → Add domain** → `fnxholding.com` → adicione os registros DNS na Cloudflare (botão automático).
2. **API Keys → Create** → copie a chave (começa com `re_`).

### 4. Stripe
> Recomendo uma **conta Stripe separada** da Molina (no mesmo login: menu da conta → **New account**),
> para o nome "FNX DEV" aparecer na fatura e as vendas não se misturarem.
1. **Settings → Payment methods**: ative **Cards** e **Boleto**. Se aparecer **Pix**, ative também e troque
   `PAYMENT_METHODS_BRL` para `"card,boleto,pix"` no `wrangler.jsonc`.
2. **Settings → Payment methods → Cards → Installments**: ative o parcelamento (confira as taxas de parcelado).
3. **Developers → API keys**: copie a **Secret key** (`sk_test_...` para testar, `sk_live_...` para valer).
4. **Developers → Webhooks → Add endpoint**:
   - URL: `https://dev.fnxholding.com/api/stripe-webhook`
   - Eventos: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
   - Copie o **Signing secret** (`whsec_...`).

### 5. Colocar os segredos no Worker
Cloudflare → Worker `fnx-dev` → **Settings → Variables and Secrets → Add** (tipo **Secret**):

| Nome | Valor |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` (depois troque por `sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` |
| `RESEND_API_KEY` | `re_...` |

### 6. Testar (modo teste da Stripe)
- Cartão aprovado: `4242 4242 4242 4242`, validade futura, CVC qualquer.
- Verifique se chegam em **vendas.fnxholding@gmail.com**: “Pré-cadastro” → “Nova venda” (com contrato).
- Teste o formulário personalizado e o de contato.
- Quando tudo funcionar: troque as chaves para as **live** (inclusive um webhook novo no modo live, com novo `whsec_`).

---

## Como alterar no dia a dia

**Preços:** mude em **dois lugares** — `public/index.html` (`const PLANOS`, em reais/dólares) e
`src/worker.js` (`const PLANOS`, em **centavos**: R$ 300 = `30000`). O valor cobrado é sempre o do worker.

**Textos / tradução:** no `index.html`, o português fica dentro da tag e o inglês no atributo `data-en="..."`
da mesma tag. Mudou um texto em português? Mude o `data-en` ao lado. Textos dos planos ficam em `const PLANOS`
(partes `pt` e `en`); mensagens geradas pelo script ficam em `const TXT`.

**Contrato:** cole o texto em `src/worker.js`, na constante `CONTRATO_TEXTO` (português) e, se tiver,
`CONTRATO_TEXTO_EN` (inglês), entre as crases.
Campos automáticos: `{{NOME}} {{DOCUMENTO}} {{EMAIL}} {{TELEFONE}} {{ENDERECO}} {{CIDADE}} {{PAIS}} {{EMPRESA}} {{PLANO}} {{VALOR}} {{DATA}} {{PEDIDO}} {{DESCRICAO}}`.
Também cole a versão pública em `public/politicas.html` (seção `#contrato`) e `public/policies.html` (seção `#contract`).

**Logo:** no `index.html`, troque o `<a class="brand">FNX <span>DEV</span></a>` (no topo e no rodapé) por uma `<img>`.

**Print da Molina:** salve como `public/assets/projetos/molina.webp` — ele substitui o mockup automaticamente.

**Países bloqueados:** `const BLOQUEADOS` em `src/worker.js` **e** em `public/index.html`.

### Enviar alterações para o GitHub (publica sozinho)
```bash
git add .
git commit -m "Descreva aqui o que mudou"
git push
```
Em 1–2 minutos a Cloudflare publica a nova versão (acompanhe em Workers → fnx-dev → Deployments).
