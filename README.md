# Plataforma de agendamento para clínicas

Projeto de portfólio de Luís Felipe Andrade. Uma cliente escolhe um serviço e reserva um horário online. A equipe acompanha a reserva na agenda e o sistema impede que duas reservas ocupem o mesmo horário da mesma profissional.

Veja a [demo em quatro telas](demo/README.md).

## O que a demonstração cobre

- Catálogo com serviços, duração, preços e horários de atendimento por clínica.
- Página pública de agendamento e painel para acompanhar reservas.
- Duas clínicas de exemplo, com dados separados e permissões para proprietária, recepção e profissional.
- Bloqueio de reservas simultâneas em horários sobrepostos.
- Vínculo da reserva ao cadastro e registro de atendimento pela profissional designada.

## Como construí com IA

Defini os fluxos da cliente e da equipe, transformei requisitos em instruções iterativas para o Codex e revisei o comportamento no navegador. Uma decisão foi tratar o conflito de horários no banco de dados. Mesmo quando duas pessoas tentam reservar ao mesmo tempo, apenas uma reserva pode ser confirmada para o mesmo intervalo.

## Como experimentar

Com Node.js 24 ou superior, execute na pasta do projeto:

```bash
npm ci
npm start
```

1. Abra [a página de agendamento](http://127.0.0.1:4175/clinica/clinica-a) e faça uma reserva de teste.
2. Abra [o painel](http://127.0.0.1:4175/) e entre com `proprietaria@clinica-a.test` e a senha temporária exibida no terminal.
3. Abra a agenda e confira a reserva. Volte à página pública e observe que o horário ocupado deixou de aparecer.
4. Na agenda, escolha **Vincular paciente**. Use `Marina Exemplo` ou crie um cadastro com o nome fictício da reserva.
5. Entre como `profissional@clinica-a.test`. Na mesma data, use **Registrar atendimento** e confira a ficha.
6. Execute `npm test` para verificar permissões, isolamento entre clínicas, conflitos de horários e registro do atendimento.

A demonstração usa dados fictícios. O banco local é recriado quando o servidor reinicia.

**Tecnologias** · JavaScript, Node.js, PostgreSQL via PGlite, HTML e CSS.
