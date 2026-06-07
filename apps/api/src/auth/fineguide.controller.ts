import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { ProfilePayload, PlanPayload } from '@fineguide-tesseract/shared';
import { FineguideService } from './fineguide.service';
import { JwtAuthGuard, type JwtClaims } from './jwt-auth.guard';

/** Bearer-guarded profile + plan writes. In dev these hit the local mock; in prod
 *  they forward to fineguide.ai (the FineguideService seam). Each returns a fresh token. */
@Controller('fineguide')
export class FineguideController {
  constructor(private readonly fineguide: FineguideService) {}

  @Post('profile')
  @UseGuards(JwtAuthGuard)
  profile(@Req() req: FastifyRequest & { user: JwtClaims }, @Body() body: ProfilePayload) {
    return this.fineguide.updateProfile(req.user.sub, bearer(req), body);
  }

  @Post('plan')
  @UseGuards(JwtAuthGuard)
  plan(@Req() req: FastifyRequest & { user: JwtClaims }, @Body() body: PlanPayload) {
    return this.fineguide.setPlan(req.user.sub, bearer(req), body);
  }
}

/** The raw Bearer token (the guard already verified it) — needed to forward upstream. */
function bearer(req: FastifyRequest): string {
  const header = req.headers['authorization'];
  return typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : '';
}
