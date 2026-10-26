import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { AuthUser } from '../../common/auth/auth-user';
import { CurrentUser, Public, SkipSubscriptionCheck } from '../../common/auth/decorators';
import { AuthService } from './auth.service';

class LoginDto {
  @ApiProperty({ example: 'dono@barbearia.com' }) @IsEmail() email: string;
  @ApiProperty() @IsString() @MinLength(6) password: string;
}

class RefreshDto {
  @ApiProperty() @IsString() refreshToken: string;
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @ApiBearerAuth()
  @SkipSubscriptionCheck()
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthUser): Promise<void> {
    await this.auth.logout(user.sub);
  }

  @ApiBearerAuth()
  @SkipSubscriptionCheck()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.sub);
  }
}
