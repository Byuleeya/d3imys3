FROM node:22-alpine
WORKDIR /app
COPY package.json ./
# Copy all top-level ES modules, including newly introduced helper modules.
# In v1.1, failure_policy.mjs was present in the ZIP but accidentally omitted here.
COPY *.mjs ./
# Fail the Docker build immediately for missing relative imports or syntax errors.
RUN node verify_local_imports.mjs && \
    node --check monitor.mjs && \
    node --check parser.mjs && \
    node --check sources.mjs && \
    node --check failure_policy.mjs
ENV TZ=Asia/Seoul NODE_ENV=production
CMD ["node", "monitor.mjs"]
