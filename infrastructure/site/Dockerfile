FROM node:22.22.3-bookworm-slim
ENV NODE_ENV=production SITE_HOST=0.0.0.0 SITE_PORT=8080 SITE_DATA_FILE=/data/site.sqlite
WORKDIR /app
COPY --chown=node:node dist ./dist
COPY --chown=node:node site-server.mjs project.interface.json .release.json ./
COPY --chown=node:node deployment*.json ./
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/health',{headers:{Host:new URL(process.env.SITE_PUBLIC_ORIGIN).host}}).then(async r=>{const p=await r.json();process.exit(r.ok&&p.data.status==='ok'?0:1)}).catch(()=>process.exit(1))"
CMD ["node","site-server.mjs","--standalone"]
