FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json server.mjs auth.mjs ./
COPY --chown=node:node public ./public
RUN mkdir /app/.data && chown node:node /app/.data
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
