FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY addon.js .
EXPOSE 8080
ENV PORT=8080
CMD ["node", "addon.js"]
